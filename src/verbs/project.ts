import { PROJECT_KINDS } from "../projectFeatures";
import { ensureProjectChannels } from "../chat/defaults";
import { defineVerb } from "./table";
import { optString, reqString, stateParam } from "./params";
import { badRequest, conflict, notFound, HubError } from "../errors";
import { getNamespaceBySlug, listNamespaces } from "../db/namespaces";
import { createProject, getProjectByPath, listProjects, setProjectState } from "../db/projects";
import { recordEvent } from "../db/events";
import { deleteProject, projectDeleteKey } from "../db/projectDelete";
import { createRepo, RepoProvisioningPending } from "../code/ardi";
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
  // Channels are managed only through channel.* (ruling C-2).
  if (!project || project.kind === "channel" || project.kind === "agent-src") throw notFound("no such project");
  if (await ctx.db.prepare("SELECT 1 FROM meta WHERE key = ?").bind(projectDeleteKey(ctx.tenant!.id, project.id)).first()) throw conflict("project deletion has started; sign in on the web to retry deletion");
  if (project.state === state) throw conflict(`project already ${state}`);
  if (!await setProjectState(ctx.db, ctx.tenant!.id, project.id, state)) throw conflict("project changed; reload and try again");
  const path = nsSlug ? `${nsSlug}/${slug}` : slug;
  await recordEvent(ctx.db, {
    tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: verb, target_kind: "project", target_id: project.id,
    summary: `${state === "archived" ? "Archived" : "Unarchived"} project ${path}`,
  }, ctx.now);
  return { ok: true };
}

export const projectCreate = defineVerb({
  name: "project.create", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null, summary: "Create a project, optionally inside a namespace.",
  formBack: (r) => `/${(r as { project: { path: string } }).project.path}`,
  mcp: { scope: "write", destructive: false, title: "Create project", input: { type: "object", properties: {
    slug: { type: "string" }, kind: { type: "string", enum: PROJECT_KINDS }, display_name: { type: "string" }, namespace: { type: "string" },
  }, required: ["slug", "kind", "display_name"], additionalProperties: false } },
  parse: (i) => ({
    slug: reqString(i, "slug", { max: 63 }), kind: reqString(i, "kind", { max: 20 }),
    display_name: reqString(i, "display_name", { max: 80 }), namespace: optString(i, "namespace", { max: 63 }),
  }),
  run: async (ctx, p) => {
    const ns = await resolveNamespace(ctx, p.namespace);
    const existing = await getProjectByPath(ctx.db, ctx.tenant!.id, p.namespace, p.slug);
    const pendingKey = (id: string) => `repo-provision:${ctx.tenant!.id}:${id}`;
    const retry = existing?.kind === "repo" && p.kind === "repo" && ctx.env.GIT_BACKEND === "artifacts"
      && await ctx.db.prepare("SELECT 1 FROM meta WHERE key = ?").bind(pendingKey(existing.id)).first();
    if (retry && ctx.env.ARDI_REPO_CREATE !== "on") throw conflict("repository provisioning is disabled; pending project retained");
    if (retry && (existing!.state !== "active" || await ctx.db.prepare("SELECT 1 FROM meta WHERE key = ?").bind(projectDeleteKey(ctx.tenant!.id, existing!.id)).first())) throw conflict("pending repository project is archived or being deleted");
    const project = retry ? existing! : await createProject(ctx.db, { tenant_id: ctx.tenant!.id, namespace_id: ns?.id ?? null, slug: p.slug, kind: p.kind, display_name: p.display_name }, ctx.now);
    // Confirmed storage refusals roll back; ambiguous creates retain the ownership ID for a safe retry.
    if (project.kind === "repo" && ctx.env.ARDI_REPO_CREATE === "on") {
      try {
        await createRepo(ctx.env, ctx.db, { identity_id: ctx.identity!.id, tenant_id: ctx.tenant!.id, org: ctx.tenant!.slug, name: project.slug }, ctx.now);
      } catch (e) {
        if (retry || e instanceof RepoProvisioningPending) {
          await ctx.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, 'pending')").bind(pendingKey(project.id)).run();
        } else {
          await ctx.db.prepare("DELETE FROM project WHERE id = ? AND tenant_id = ?").bind(project.id, ctx.tenant!.id).run();
        }
        throw e;
      }
    }
    await ctx.db.prepare("DELETE FROM meta WHERE key = ?").bind(pendingKey(project.id)).run();
    const path = ns ? `${ns.slug}/${project.slug}` : project.slug;
    await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "project.create", target_kind: "project", target_id: project.id, summary: `Created project ${path}` }, ctx.now);
    const channels = project.namespace_id === null ? await ensureProjectChannels(ctx.db, project, ctx.identity!.id, ctx.now, project.kind === "workspace" && ctx.identity!.kind === "agent") : [];
    return { project: { ...project, path }, channels };
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

export const projectDelete = defineVerb({
  name: "project.delete", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 10, humanOnly: true,
  summary: "Permanently delete an archived project and its contents. Sign in on the web and type the project slug to confirm.",
  formBack: () => "/archive",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }), namespace: optString(i, "namespace", { max: 63 }), confirm: optString(i, "confirm", { max: 63 }) }),
  run: async (ctx, p) => {
    if (ctx.authKind !== "cookie" || ctx.session?.kind !== "browser" || ctx.playground) throw new HubError(403, "forbidden", "sign in on the web to delete a project");
    const project = await getProjectByPath(ctx.db, ctx.tenant!.id, p.namespace, p.slug);
    if (!project || project.kind === "channel" || project.kind === "agent-src") throw notFound("no such project");
    if (p.confirm !== project.slug) throw badRequest("type the project slug exactly to confirm");
    return deleteProject(ctx, project);
  },
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
