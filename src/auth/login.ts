import type { Env } from "../env";
import { getIdentityByEmail, normalizeEmail } from "../db/identities";
import { hasActiveConsent } from "../db/consent";
import { createAuthLink } from "../db/authLinks";
import { recordEvent } from "../db/events";
import { isValidTenantSlug } from "../tenant";
import { takeRate } from "../rate";
import { sendMail } from "../mail/send";
import type { Identity, LinkPurpose } from "../db/types";

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
}
