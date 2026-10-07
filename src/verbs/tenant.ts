import { defineVerb } from "./table";
import { applyStandingGrants } from "../auth/googleAdmit";
import { optString, reqString, stateParam } from "./params";
import { confirmMatches, deleteTenant } from "../db/tenantDelete";
import { conflict, notFound } from "../errors";
import { createTenant, getTenantBySlug, listTenants, setTenantState } from "../db/tenants";
import { recordEvent } from "../db/events";
import { revokeGrantsFor } from "../db/oauthGrants";
import { dropLibraryGrant } from "../oauth/revoke";
import type { Ctx } from "../auth/context";
import type { State } from "../db/types";

async function setState(ctx: Ctx, slug: string, state: State, verb: string) {
  const t = await getTenantBySlug(ctx.db, slug);
  if (!t) throw notFound("no such tenant");
  if (t.state === state) throw conflict(`tenant already ${state}`);
  await setTenantState(ctx.db, t.id, state, ctx.now);
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
  name: "tenant.create", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: 60,
  summary: "Create a tenant (root only).",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }), display_name: reqString(i, "display_name", { max: 80 }) }),
  run: async (ctx, p) => {
    const tenant = await createTenant(ctx.db, p, ctx.now);
    // People granted admin or membership on every tenant get this one too (Google sign-in rules).
    await applyStandingGrants(ctx.db, tenant.id, ctx.now);
    await recordEvent(ctx.db, { tenant_id: tenant.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "tenant.create", target_kind: "tenant", target_id: tenant.id, summary: `Created tenant ${tenant.slug}` }, ctx.now);
    return { tenant };
  },
});

export const tenantArchive = defineVerb({
  name: "tenant.archive", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: 60, summary: "Archive a tenant.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }) }),
  run: (ctx, p) => setState(ctx, p.slug, "archived", "tenant.archive"),
});

export const tenantUnarchive = defineVerb({
  name: "tenant.unarchive", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: 60, summary: "Unarchive a tenant.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }) }),
  run: (ctx, p) => setState(ctx, p.slug, "active", "tenant.unarchive"),
});

export const tenantList = defineVerb({
  name: "tenant.list", kind: "query", scope: "hub", minRole: "root", freshProofMinutes: null, summary: "List tenants.",
  parse: (i) => ({ state: stateParam(i) }),
  run: async (ctx, p) => ({ tenants: await listTenants(ctx.db, p.state) }),
});

export const tenantDelete = defineVerb({
  name: "tenant.delete", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: 10, humanOnly: true,
  summary: "Permanently delete an archived organization and everything the hub holds for it. Type its name in confirm. The name stays reserved until its git data is purged.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }), confirm: optString(i, "confirm", { max: 63 }) }),
  run: async (ctx, p) => {
    confirmMatches(p.slug, p.confirm);
    const r = await deleteTenant(ctx.db, p.slug, ctx.identity!.id, ctx.now);
    const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
    await recordEvent(ctx.db, {
      tenant_id: null, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "tenant.delete", target_kind: "tenant", target_id: r.tenant_id,
      summary: `Deleted organization ${r.slug}: ${total} rows, ${r.agents_deleted} helper accounts. Git data kept until Ardi can purge it; the name stays reserved.`,
    }, ctx.now);
    return r;
  },
});
