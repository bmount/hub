import { defineVerb } from "./table";
import { optString, reqString } from "./params";
import { badRequest, forbidden, notFound, unauthorized } from "../errors";
import { getIdentityByEmail } from "../db/identities";
import { addressInput, linkIdentityEmail, listIdentityEmails } from "../db/identityEmails";
import { getMembership } from "../db/memberships";
import { isHubAddress } from "../db/agents";
import { recordEvent } from "../db/events";
import type { Ctx } from "../auth/context";

async function target(ctx: Ctx, member: string | null, adding: boolean) {
  if (!ctx.identity || ctx.identity.kind !== "human" || !ctx.session) throw unauthorized();
  const identity = member ? await getIdentityByEmail(ctx.db, member) : ctx.identity;
  if (!identity || identity.kind !== "human" || identity.state !== "active") throw notFound("no such member");
  // An admin attests ownership of a global address. A tenant admin must never
  // attach a mailbox to root or another admin, including their own identity.
  if (adding && identity.id === ctx.identity.id && ctx.identity.is_root === 1) return identity;
  if (adding || identity.id !== ctx.identity.id) {
    if (!ctx.tenant || (ctx.role !== "admin" && ctx.role !== "root")) throw forbidden("an organization admin must confirm this address");
    const membership = await getMembership(ctx.db, identity.id, ctx.tenant.id);
    if (membership?.state !== "active" && !ctx.identity.is_root) throw notFound("no such member here");
    if (ctx.identity.is_root && membership?.state !== "active" && !identity.is_root) throw notFound("no such member here");
    if (!ctx.identity.is_root && await ctx.db.prepare("SELECT 1 FROM membership WHERE identity_id = ? AND tenant_id <> ? AND state = 'active' LIMIT 1").bind(identity.id, ctx.tenant.id).first()) throw forbidden("only root may change addresses for people in several organizations");
    if (!ctx.identity.is_root && (identity.is_root || membership?.role === "admin")) throw forbidden("only root may confirm addresses for admins");
  }
  return identity;
}

const base = {kind: "command", scope: "public", minRole: "public", humanOnly: true, freshProofMinutes: 60} as const;
export const identityEmailAdd = defineVerb({...base, name: "identity.email_add",
  summary: "An organization admin confirms an additional address for a human member. Only root may confirm an admin's address.",
  parse: i => ({member: optString(i, "member", {max: 254}), email: addressInput(reqString(i, "email", {max: 254}))}),
  run: async (ctx, p) => {
    if (isHubAddress(p.email, ctx.env.HUB_DOMAIN)) throw badRequest("hub addresses cannot belong to a person");
    const person = await target(ctx, p.member, true);
    await linkIdentityEmail(ctx.db, person.id, p.email, ctx.identity!.id, ctx.now);
    await recordEvent(ctx.db, {tenant_id: ctx.tenant?.id ?? null, identity_id: ctx.identity!.id, session_id: ctx.session!.id,
      kind: "identity.email_add", target_kind: "identity", target_id: person.id, summary: `Admin confirmed ${p.email} for ${person.display_name}`}, ctx.now);
    return {email: p.email, confirmed: true};
  },
});
export const identityEmailRemove = defineVerb({...base, name: "identity.email_remove",
  summary: "Remove a linked address from your account, or (admins) from a member's account. Primary addresses cannot be removed.",
  parse: i => ({member: optString(i, "member", {max: 254}), email: addressInput(reqString(i, "email", {max: 254}))}),
  run: async (ctx, p) => {
    const person = await target(ctx, p.member, false);
    if (person.email === p.email) throw badRequest("the primary address cannot be removed");
    const result = await ctx.db.prepare("DELETE FROM identity_email WHERE identity_id = ? AND email = ?").bind(person.id, p.email).run();
    await recordEvent(ctx.db, {tenant_id: ctx.tenant?.id ?? null, identity_id: ctx.identity!.id, session_id: ctx.session!.id,
      kind: "identity.email_remove", target_kind: "identity", target_id: person.id, summary: `Removed linked address ${p.email}`}, ctx.now);
    return {email: p.email, removed: result.meta.changes === 1};
  },
});
export const identityEmailList = defineVerb({name: "identity.email_list", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null,
  summary: "List your linked addresses, or (admins) a member's linked addresses.",
  parse: i => ({member: optString(i, "member", {max: 254})}),
  run: async (ctx,p) => {const person = await target(ctx,p.member,false); return {primary: person.email, addresses: (await listIdentityEmails(ctx.db,person.id)).results};},
});
