import { defineVerb } from "./table";
import { optString } from "./params";
import { notFound, unauthorized } from "../errors";
import { getIdentityByEmail, normalizeEmail } from "../db/identities";
import { getMembership } from "../db/memberships";
import { listConsent, revokeConsent } from "../db/consent";
import { recordEvent } from "../db/events";
import type { Ctx } from "../auth/context";

async function consentTarget(ctx: Ctx, email: string | null): Promise<{ email: string; tenant_id: string | null }> {
  if (!ctx.identity || !ctx.session) throw unauthorized();
  const own = ctx.identity.email;
  if (!email || normalizeEmail(email) === own) return { email: own, tenant_id: null };
  const target = normalizeEmail(email);
  if (ctx.identity.is_root === 1) return { email: target, tenant_id: ctx.tenant?.id ?? null };
  if (ctx.tenant && ctx.role === "admin") {
    const other = await getIdentityByEmail(ctx.db, target);
    const m = other ? await getMembership(ctx.db, other.id, ctx.tenant.id) : null;
    if (m && m.state === "active") return { email: target, tenant_id: ctx.tenant.id };
  }
  throw notFound("no such address");
}

export const consentList = defineVerb({
  name: "consent.list", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null,
  summary: "List mail consent for your address (tenant admins: a member's address; roots: any address).",
  parse: (i) => ({ email: optString(i, "email", { max: 254 }) }),
  run: async (ctx, p) => {
    const t = await consentTarget(ctx, p.email);
    const rows = await listConsent(ctx.db, t.email);
    return {
      email: t.email,
      active: rows.some((r) => r.revoked_at === null),
      consents: rows.map((r) => ({ id: r.id, kind: r.kind, granted_at: r.granted_at, revoked_at: r.revoked_at })),
    };
  },
});

export const consentRevoke = defineVerb({
  name: "consent.revoke", kind: "command", scope: "public", minRole: "public", freshProofMinutes: null,
  summary: "Revoke mail consent: the hub stops emailing that address until it writes to login@ again.",
  parse: (i) => ({ email: optString(i, "email", { max: 254 }) }),
  run: async (ctx, p) => {
    const t = await consentTarget(ctx, p.email);
    const revoked = await revokeConsent(ctx.db, t.email, ctx.now);
    await recordEvent(ctx.db, {
      tenant_id: t.tenant_id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "consent.revoke",
      target_kind: "email", target_id: t.email, summary: `Revoked mail consent for ${t.email} (${revoked} row${revoked === 1 ? "" : "s"})`,
    }, ctx.now);
    return { email: t.email, revoked };
  },
});
