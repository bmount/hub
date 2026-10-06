import { defineVerb } from "./table";
import { reqString, stateParam } from "./params";
import { conflict, notFound } from "../errors";
import { createTenant, getTenantBySlug, listTenants, setTenantState } from "../db/tenants";
import { recordEvent } from "../db/events";
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
  return { ok: true };
}

export const tenantCreate = defineVerb({
  name: "tenant.create", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: 60,
  summary: "Create a tenant (root only).",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }), display_name: reqString(i, "display_name", { max: 80 }) }),
  run: async (ctx, p) => {
    const tenant = await createTenant(ctx.db, p, ctx.now);
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
