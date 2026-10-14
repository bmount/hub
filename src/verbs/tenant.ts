import { defineVerb } from "./table";
import { applyStandingGrants } from "../auth/googleAdmit";
import { optString, reqString, stateParam } from "./params";
import { confirmMatches, deleteTenant } from "../db/tenantDelete";
import { conflict, notFound, HubError } from "../errors";
import { getMembership } from "../db/memberships";
import { takeRateAtomic } from "../rate";
import { purgeTenantStores } from "../db/tenantStores";
import { createTenant, getTenantBySlug, listTenants, setTenantState, validateTenantInput } from "../db/tenants";
import { recordEvent } from "../db/events";
import { revokeGrantsFor } from "../db/oauthGrants";
import { dropLibraryGrant } from "../oauth/revoke";
import type { Ctx } from "../auth/context";
import type { State } from "../db/types";

async function authorizeTenant(ctx: Ctx, slug: string) {
  if (!ctx.identity || ctx.identity.kind !== "human") throw new HubError(403, "forbidden", "organization management is human-only");
  const t = await getTenantBySlug(ctx.db, slug);
  if (!t) throw notFound("no such tenant");
  const m = await getMembership(ctx.db, ctx.identity.id, t.id);
  if (ctx.identity.is_root !== 1 && (!m || m.state !== "active" || m.role !== "admin")) throw new HubError(403, "forbidden");
  return t;
}

async function setState(ctx: Ctx, slug: string, state: State, verb: string) {
  const t = await authorizeTenant(ctx, slug);
  if (await ctx.db.prepare("/*perf-site:src%2Fverbs%2Ftenant.ts:27:13:setState*/ SELECT 1 FROM meta WHERE key = ?").bind(`tenant_delete:v1:${t.id}`).first()) throw conflict("organization deletion has begun; retry deletion");
  if (t.state === state) throw conflict(`tenant already ${state}`);
  if (!await setTenantState(ctx.db, t.id, state, ctx.now)) throw conflict("organization state changed; reload and retry");
  await recordEvent(ctx.db, {
    tenant_id: t.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: verb, target_kind: "tenant", target_id: t.id,
    summary: `${state === "archived" ? "Archived" : "Unarchived"} tenant ${t.slug}`,
  }, ctx.now);
  // Cascade (MCP spec 10.3): archiving a tenant revokes its assistant grants; unarchiving does not restore them.
  if (state === "archived") {
    for (const g of await revokeGrantsFor(ctx.db, { tenant_id: t.id }, ctx.identity!.id, "tenant_archived", ctx.now)) await dropLibraryGrant(ctx.env, g);
  }
  return { ok: true };
}

export const tenantCreate = defineVerb({
  name: "tenant.create", kind: "command", scope: "hub", minRole: "public", freshProofMinutes: null, humanOnly: true,
  summary: "Create an organization as a signed-in human; the creator becomes its admin.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }), display_name: reqString(i, "display_name", { max: 80 }) }),
  run: async (ctx, p) => {
    if (!ctx.identity || ctx.identity.kind !== "human") throw new HubError(401, "unauthorized");
    validateTenantInput(p);
    if (!(await takeRateAtomic(ctx.db, "tenant_create_identity", ctx.identity.id, ctx.now)).ok) throw new HubError(429, "rate_limited");
    const tenant = await createTenant(ctx.db, p, ctx.now, ctx.identity.id);
    // People granted admin or membership on every tenant get this one too (Google sign-in rules).
    await applyStandingGrants(ctx.db, tenant.id, ctx.now);
    await recordEvent(ctx.db, { tenant_id: tenant.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "tenant.create", target_kind: "tenant", target_id: tenant.id, summary: `Created tenant ${tenant.slug}` }, ctx.now);
    return { tenant };
  },
});

export const tenantArchive = defineVerb({
  name: "tenant.archive", kind: "command", scope: "hub", minRole: "public", humanOnly: true, freshProofMinutes: 10, summary: "Archive a tenant.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }) }),
  run: (ctx, p) => setState(ctx, p.slug, "archived", "tenant.archive"),
});

export const tenantUnarchive = defineVerb({
  name: "tenant.unarchive", kind: "command", scope: "hub", minRole: "public", humanOnly: true, freshProofMinutes: 10, summary: "Unarchive a tenant.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }) }),
  run: (ctx, p) => setState(ctx, p.slug, "active", "tenant.unarchive"),
});

export const tenantList = defineVerb({
  name: "tenant.list", kind: "query", scope: "hub", minRole: "root", freshProofMinutes: null, summary: "List tenants.",
  parse: (i) => ({ state: stateParam(i) }),
  run: async (ctx, p) => ({ tenants: await listTenants(ctx.db, p.state) }),
});

export const tenantDelete = defineVerb({
  name: "tenant.delete", kind: "command", scope: "hub", minRole: "public", freshProofMinutes: 10, humanOnly: true,
  summary: "Permanently delete an archived organization and its repositories through a fresh web sign-in. Type its slug in confirm; the name stays reserved.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }), confirm: optString(i, "confirm", { max: 63 }) }),
  run: async (ctx, p) => {
    const tenant = await authorizeTenant(ctx, p.slug);
    if (ctx.authKind !== "cookie" || ctx.session?.kind !== "browser") throw new HubError(403, "forbidden", "organization deletion requires a web sign-in");
    confirmMatches(p.slug, p.confirm);
    if (tenant.state !== "archived") throw conflict("archive the organization before deleting it");
    await ctx.db.prepare("/*perf-site:src%2Fverbs%2Ftenant.ts:84:11:tenantDelete*/ INSERT OR IGNORE INTO meta (key, value) SELECT ?, 'deleting' FROM tenant WHERE id = ? AND state = 'archived'").bind(`tenant_delete:v1:${tenant.id}`, tenant.id).run();
    if (!await ctx.db.prepare("/*perf-site:src%2Fverbs%2Ftenant.ts:85:16:tenantDelete*/ SELECT 1 FROM meta WHERE key = ?").bind(`tenant_delete:v1:${tenant.id}`).first()) throw conflict("archive the organization before deleting it");
    await purgeTenantStores(ctx, tenant);
    const r = await deleteTenant(ctx.db, p.slug, ctx.identity!.id, ctx.now);
    const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
    await recordEvent(ctx.db, {
      tenant_id: null, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "tenant.delete", target_kind: "tenant", target_id: r.tenant_id,
      summary: `Deleted organization ${r.slug}: ${total} rows, ${r.agents_deleted} agent accounts. External data purged; the name stays reserved.`,
    }, ctx.now);
    return r;
  },
});
