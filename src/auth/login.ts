import type { Env } from "../env";
import { getIdentityByEmail, normalizeEmail } from "../db/identities";
import { hasActiveConsent } from "../db/consent";
import { createAuthLink } from "../db/authLinks";
import { recordEvent } from "../db/events";
import { isValidTenantSlug } from "../tenant";
import { takeRate } from "../rate";
import { sendMail } from "../mail/send";
import type { Ctx } from "./context";
import { getIdentityById } from "../db/identities";
import { authLinkIsOpen, claimAuthLink, findAuthLinkByToken } from "../db/authLinks";
import { recordProof } from "../db/proofs";
import { createBrowserSession, setLastProof } from "../db/sessions";
import { getTenantBySlug } from "../db/tenants";
import { getMembership } from "../db/memberships";
import type { AuthLink, Identity, LinkPurpose, Session } from "../db/types";

export const NEUTRAL_LOGIN_MESSAGE = "If that address is known and has consented, a link is on its way. It expires in 15 minutes.";

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+$/;

export function cleanNext(next: string | null | undefined): string | null {
  if (!next) return null;
  const s = next.trim().toLowerCase();
  return isValidTenantSlug(s) ? s : null;
}

export function authUrl(env: Env, token: string, next: string | null): string {
  return `https://${env.HUB_DOMAIN}/auth/${token}` + (next ? `?next=${encodeURIComponent(next)}` : "");
}

export function linkMail(purpose: LinkPurpose, url: string): { subject: string; text: string } {
  if (purpose === "reproof") {
    return {
      subject: "Confirm it's you on Pimwell",
      text: [
        "A browser signed in as you asked to confirm a sensitive action on Pimwell.",
        "",
        "Open this link in that same browser within 15 minutes:",
        url,
        "",
        "If this was not you, ignore this message.",
      ].join("\n"),
    };
  }
  return {
    subject: "Your Pimwell sign-in link",
    text: [
      "Open this link within 15 minutes to sign in to Pimwell:",
      url,
      "",
      "The link works once. If you did not ask for it, ignore this message.",
    ].join("\n"),
  };
}

export type LinkRequest = { email: string; purpose: LinkPurpose; ip: string; next: string | null; session_id: string | null };

export async function issueLink(
  env: Env,
  input: { identity: Identity; purpose: LinkPurpose; next: string | null; via: "outbound" | "inbound"; session_id: string | null },
  now: number,
): Promise<string> {
  const { link, token } = await createAuthLink(env.HUB_DB, input.identity.id, input.purpose, now);
  await recordEvent(env.HUB_DB, {
    tenant_id: null, identity_id: input.identity.id, session_id: input.session_id, kind: "auth_link.create",
    target_kind: "auth_link", target_id: link.id, summary: `Issued ${input.purpose} link (${input.via})`,
  }, now);
  return authUrl(env, token, cleanNext(input.next));
}

// Outbound path (spec 6.3). Returns nothing: callers always answer neutrally.
export async function requestLink(env: Env, req: LinkRequest, now: number): Promise<void> {
  try {
    const email = normalizeEmail(req.email);
    if (email.length > 254 || !EMAIL_SHAPE.test(email)) return;
    if (!(await takeRate(env.RATE, "ip", req.ip, now))) return;
    const identity = await getIdentityByEmail(env.HUB_DB, email);
    if (!identity || identity.kind !== "human" || identity.state !== "active") return;
    // Early exit so no link or rate budget is spent; sendMail enforces the same rule.
    if (!(await hasActiveConsent(env.HUB_DB, email))) return;
    if (!(await takeRate(env.RATE, "addr", email, now))) return;
    const url = await issueLink(env, { identity, purpose: req.purpose, next: req.next, via: "outbound", session_id: req.session_id }, now);
    await sendMail(env, { to: email, ...linkMail(req.purpose, url) }, now);
  } catch (e) {
    // Fail closed and silent: an error must not distinguish known addresses.
    console.log("login request failed", e instanceof Error ? e.name : "error");
  }
}

export async function landingUrl(env: Env, identity: Identity, next: string | null): Promise<string> {
  const home = `https://${env.HUB_DOMAIN}/`;
  const slug = cleanNext(next);
  if (!slug) return home;
  const tenant = await getTenantBySlug(env.HUB_DB, slug);
  if (!tenant || tenant.state !== "active") return home;
  const there = `https://${slug}.${env.HUB_DOMAIN}/`;
  if (identity.is_root === 1) return there;
  const m = await getMembership(env.HUB_DB, identity.id, tenant.id);
  return m && m.state === "active" ? there : home;
}

export async function openLink(env: Env, token: string, now: number): Promise<{ link: AuthLink; identity: Identity } | null> {
  const link = await findAuthLinkByToken(env.HUB_DB, token);
  if (!link || !authLinkIsOpen(link, now)) return null;
  const identity = await getIdentityById(env.HUB_DB, link.identity_id);
  if (!identity || identity.kind !== "human" || identity.state !== "active") return null;
  return { link, identity };
}

export type ConsumeResult =
  | { kind: "invalid" }
  | { kind: "wrong_browser" }
  | { kind: "ok"; identity: Identity; session: Session; newToken: string | null; purpose: LinkPurpose; location: string };

export async function consumeLink(env: Env, ctx: Ctx, token: string, next: string | null, now: number): Promise<ConsumeResult> {
  const open = await openLink(env, token, now);
  if (!open) return { kind: "invalid" };
  const { link, identity } = open;
  const own = ctx.identity?.id === identity.id && ctx.session?.kind === "browser" ? ctx.session : null;
  // A reproof link refreshes the session that asked; anywhere else, leave it unused.
  if (link.purpose === "reproof" && !own) return { kind: "wrong_browser" };
  if (!(await claimAuthLink(env.HUB_DB, link.id, now))) return { kind: "invalid" };
  await recordProof(env.HUB_DB, { identity_id: identity.id, kind: "email", subject: identity.email }, now);
  let session: Session;
  let newToken: string | null = null;
  if (own) {
    await setLastProof(env.HUB_DB, own.id, now);
    session = { ...own, last_proof_at: now };
  } else {
    const created = await createBrowserSession(env.HUB_DB, identity.id, now);
    session = created.session;
    newToken = created.token;
  }
  await recordEvent(env.HUB_DB, {
    tenant_id: null, identity_id: identity.id, session_id: session.id,
    kind: link.purpose === "reproof" ? "login.reproof" : "login.verify", target_kind: "auth_link", target_id: link.id,
    summary: link.purpose === "reproof" ? "Re-proved control of email" : newToken ? "Signed in with an email link" : "Refreshed proof with an email link",
  }, now);
  return { kind: "ok", identity, session, newToken, purpose: link.purpose, location: await landingUrl(env, identity, next) };
}
