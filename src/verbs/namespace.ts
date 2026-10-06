import { defineVerb } from "./table";
import { reqString } from "./params";
import { conflict, notFound } from "../errors";
import { createNamespace, getNamespaceBySlug, setNamespaceState } from "../db/namespaces";
import { recordEvent } from "../db/events";
import type { Ctx } from "../auth/context";
import type { State } from "../db/types";

async function setState(ctx: Ctx, slug: string, state: State, verb: string) {
  const ns = await getNamespaceBySlug(ctx.db, ctx.tenant!.id, slug);
  if (!ns) throw notFound("no such namespace");
  if (ns.state === state) throw conflict(`namespace already ${state}`);
  await setNamespaceState(ctx.db, ctx.tenant!.id, ns.id, state);
  await recordEvent(ctx.db, {
    tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: verb, target_kind: "namespace", target_id: ns.id,
    summary: `${state === "archived" ? "Archived" : "Unarchived"} namespace ${ns.slug}`,
  }, ctx.now);
  return { ok: true };
}

export const namespaceCreate = defineVerb({
  name: "namespace.create", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, summary: "Create a namespace.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }), display_name: reqString(i, "display_name", { max: 80 }) }),
  run: async (ctx, p) => {
    const namespace = await createNamespace(ctx.db, { tenant_id: ctx.tenant!.id, ...p }, ctx.now);
    await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "namespace.create", target_kind: "namespace", target_id: namespace.id, summary: `Created namespace ${namespace.slug}` }, ctx.now);
    return { namespace };
  },
});

export const namespaceArchive = defineVerb({
  name: "namespace.archive", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, summary: "Archive a namespace and its projects.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }) }),
  run: (ctx, p) => setState(ctx, p.slug, "archived", "namespace.archive"),
});

export const namespaceUnarchive = defineVerb({
  name: "namespace.unarchive", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, summary: "Unarchive a namespace and its projects.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }) }),
  run: (ctx, p) => setState(ctx, p.slug, "active", "namespace.unarchive"),
});
