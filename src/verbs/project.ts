import { defineVerb } from "./table";
import { optString, reqString, stateParam } from "./params";
import { conflict, notFound } from "../errors";
import { getNamespaceBySlug, listNamespaces } from "../db/namespaces";
import { createProject, getProjectByPath, listProjects, setProjectState } from "../db/projects";
import { recordEvent } from "../db/events";
import type { Ctx } from "../auth/context";
import type { Namespace, Project, State } from "../db/types";

function pathOf(p: Project, namespaces: Map<string, Namespace>): string {
  return p.namespace_id ? `${namespaces.get(p.namespace_id)?.slug ?? "?"}/${p.slug}` : p.slug;
}

async function resolveNamespace(ctx: Ctx, slug: string | null): Promise<Namespace | null> {
  if (slug === null) return null;
  const ns = await getNamespaceBySlug(ctx.db, ctx.tenant!.id, slug);
  if (!ns || ns.state !== "active") throw conflict("namespace missing or archived");
  return ns;
}

async function setState(ctx: Ctx, nsSlug: string | null, slug: string, state: State, verb: string) {
  const project = await getProjectByPath(ctx.db, ctx.tenant!.id, nsSlug, slug);
  if (!project) throw notFound("no such project");
  if (project.state === state) throw conflict(`project already ${state}`);
  await setProjectState(ctx.db, ctx.tenant!.id, project.id, state);
  const path = nsSlug ? `${nsSlug}/${slug}` : slug;
  await recordEvent(ctx.db, {
    tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: verb, target_kind: "project", target_id: project.id,
    summary: `${state === "archived" ? "Archived" : "Unarchived"} project ${path}`,
  }, ctx.now);
  return { ok: true };
}

export const projectCreate = defineVerb({
  name: "project.create", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null, summary: "Create a project, optionally inside a namespace.",
  parse: (i) => ({
    slug: reqString(i, "slug", { max: 63 }), kind: reqString(i, "kind", { max: 20 }),
    display_name: reqString(i, "display_name", { max: 80 }), namespace: optString(i, "namespace", { max: 63 }),
  }),
  run: async (ctx, p) => {
    const ns = await resolveNamespace(ctx, p.namespace);
    const project = await createProject(ctx.db, { tenant_id: ctx.tenant!.id, namespace_id: ns?.id ?? null, slug: p.slug, kind: p.kind, display_name: p.display_name }, ctx.now);
    const path = ns ? `${ns.slug}/${project.slug}` : project.slug;
    await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "project.create", target_kind: "project", target_id: project.id, summary: `Created project ${path}` }, ctx.now);
    return { project: { ...project, path } };
  },
});

export const projectArchive = defineVerb({
  name: "project.archive", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, summary: "Archive a project.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }), namespace: optString(i, "namespace", { max: 63 }) }),
  run: (ctx, p) => setState(ctx, p.namespace, p.slug, "archived", "project.archive"),
});

export const projectUnarchive = defineVerb({
  name: "project.unarchive", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, summary: "Unarchive a project.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }), namespace: optString(i, "namespace", { max: 63 }) }),
  run: (ctx, p) => setState(ctx, p.namespace, p.slug, "active", "project.unarchive"),
});

export const projectList = defineVerb({
  name: "project.list", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null, summary: "List namespaces and projects by state.",
  mcp: {
    scope: "read", destructive: false, title: "Projects",
    input: {
      type: "object",
      properties: { state: { type: "string", enum: ["active", "archived"], description: "Which projects to list, default active." } },
      additionalProperties: false,
    },
  },
  parse: (i) => ({ state: stateParam(i) }),
  run: async (ctx, p) => {
    const all = new Map<string, Namespace>();
    for (const ns of [...(await listNamespaces(ctx.db, ctx.tenant!.id, "active")), ...(await listNamespaces(ctx.db, ctx.tenant!.id, "archived"))]) all.set(ns.id, ns);
    const namespaces = [...all.values()].filter((n) => n.state === p.state);
    const projects = (await listProjects(ctx.db, ctx.tenant!.id, p.state)).map((pr) => ({ ...pr, path: pathOf(pr, all) }));
    projects.sort((a, b) => a.path.localeCompare(b.path));
    return { namespaces, projects };
  },
});
