import { PROJECT_KINDS, FEATURE_LABELS, projectFeatures, type ProjectFeature } from "../projectFeatures";
import { featureProject } from "./featureProject";
import { createRepository } from "../code/repositories";
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
  if (await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fproject.ts:29:13:setState:44558753*/ SELECT 1 FROM meta WHERE key = ?").bind(projectDeleteKey(ctx.tenant!.id, project.id)).first()) throw conflict("project deletion has started; sign in on the web to retry deletion");
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
      && await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fproject.ts:55:16:projectCreate.run:44558753*/ SELECT 1 FROM meta WHERE key = ?").bind(pendingKey(existing.id)).first();
    if (retry && ctx.env.ARDI_REPO_CREATE !== "on") throw conflict("repository provisioning is disabled; pending project retained");
    if (retry && (existing!.state !== "active" || await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fproject.ts:57:57:projectCreate.run:44558753*/ SELECT 1 FROM meta WHERE key = ?").bind(projectDeleteKey(ctx.tenant!.id, existing!.id)).first())) throw conflict("pending repository project is archived or being deleted");
    const project = retry ? existing! : await createProject(ctx.db, { tenant_id: ctx.tenant!.id, namespace_id: ns?.id ?? null, slug: p.slug, kind: p.kind, display_name: p.display_name }, ctx.now);
    // Confirmed storage refusals roll back; ambiguous creates retain the ownership ID for a safe retry.
    if (project.kind === "repo" && ctx.env.ARDI_REPO_CREATE === "on") {
      try {
        await createRepo(ctx.env, ctx.db, { identity_id: ctx.identity!.id, tenant_id: ctx.tenant!.id, org: ctx.tenant!.slug, name: project.slug }, ctx.now);
      } catch (e) {
        if (retry || e instanceof RepoProvisioningPending) {
          await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fproject.ts:65:17:projectCreate.run:6a5b395e*/ INSERT OR IGNORE INTO meta (key, value) VALUES (?, 'pending')").bind(pendingKey(project.id)).run();
        } else {
          await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fproject.ts:67:17:projectCreate.run:2fbc2a3c*/ DELETE FROM project WHERE id = ? AND tenant_id = ?").bind(project.id, ctx.tenant!.id).run();
        }
        throw e;
      }
    }
    await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fproject.ts:72:11:projectCreate.run:a535e921*/ DELETE FROM meta WHERE key = ?").bind(pendingKey(project.id)).run();
    const path = ns ? `${ns.slug}/${project.slug}` : project.slug;
    await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "project.create", target_kind: "project", target_id: project.id, summary: `Created project ${path}` }, ctx.now);
    const channels = project.namespace_id === null ? await ensureProjectChannels(ctx.db, project, ctx.identity!.id, ctx.now, project.kind === "workspace" && ctx.identity!.kind === "agent") : [];
    return { project: { ...project, path }, channels };
  },
});

const PARTS = Object.keys(FEATURE_LABELS) as ProjectFeature[];
function partList(i: Record<string, unknown>, key: string): ProjectFeature[] {
  const value = i[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PARTS.length || value.some(p => typeof p !== "string" || !PARTS.includes(p as ProjectFeature))) throw badRequest(`${key} must be an array of project parts: ${PARTS.join(", ")}`);
  return [...new Set(value)] as ProjectFeature[];
}

// History and pending uploads count too: disabling a part must never hide retained content.
export const PART_CONTENT: Record<ProjectFeature, Array<[string, string]>> = {
  docket: [["work_item", "work items"]],
  repo: [["repository", "repositories"], ["git_repository", "repository mappings"]],
  wiki: [["wiki_revision", "wiki revisions"]],
  knowledge: [["wiki_revision", "research revisions"]],
  files: [["file_revision", "file revisions"], ["file_upload", "uploads"]],
  pages: [["page_revision", "page versions"], ["page_upload", "page uploads"]],
  people: [["contact_entity", "contacts"], ["contact_connection", "connections"]],
};
export const projectUpdate = defineVerb({
  name: "project.update", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Add parts to an existing project, or remove empty parts without deleting content. Kind remains its creation template.",
  mcp: { scope: "write", destructive: false, title: "Update project parts", input: { type: "object", properties: {
    project: { type: "string" },
    add: { type: "array", items: { type: "string", enum: PARTS }, maxItems: PARTS.length },
    remove: { type: "array", items: { type: "string", enum: PARTS }, maxItems: PARTS.length },
  }, required: ["project"], additionalProperties: false } },
  formBack: (r: {project: Project & {path: string}; parts: readonly ProjectFeature[]}) => `/${r.project.path}`,
  parse: i => {
    const add = partList(i, "add"), remove = partList(i, "remove");
    // Knowledge/research use the wiki revision store and page/history tools.
    if (add.includes("knowledge") && !add.includes("wiki")) add.push("wiki");
    if (add.some(p => remove.includes(p))) throw badRequest("a part cannot be added and removed together");
    return { project: reqString(i, "project", { max: 127 }), add, remove };
  },
  run: async (ctx, v) => {
    const p = await featureProject(ctx, v.project);
    if (!PROJECT_KINDS.includes(p.kind)) throw notFound("no such project");
    if (p.state !== "active" || await ctx.db.prepare("SELECT 1 FROM meta WHERE key = ?").bind(projectDeleteKey(ctx.tenant!.id, p.id)).first()) throw conflict("project is archived or being deleted");
    const current = projectFeatures(p);
    if (v.remove.includes("wiki") && current.includes("knowledge") && !v.remove.includes("knowledge")) throw conflict("Cannot remove wiki: knowledge uses its pages. Remove empty knowledge in the same call.");
    const emptyChecks: string[] = [];
    for (const part of v.remove.filter(part => current.includes(part))) {
      for (const [table, label] of PART_CONTENT[part]) {
        const condition = table === "wiki_revision" && part === "knowledge" ? " AND research IS NOT NULL" : "";
        const count = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ? AND project_id = ?${condition}`).bind(ctx.tenant!.id, p.id).first<number>("n");
        if (count) throw conflict(`Cannot remove ${part}: it holds ${count} ${label}. Removing a part never deletes content.`);
        emptyChecks.push(`NOT EXISTS (SELECT 1 FROM ${table} content WHERE content.tenant_id = project.tenant_id AND content.project_id = project.id${condition})`);
      }
    }
    if (v.add.includes("repo")) {
      const exists = await ctx.db.prepare("SELECT 1 FROM repository WHERE tenant_id = ? AND project_id = ?").bind(ctx.tenant!.id, p.id).first();
      if (!exists) await createRepository(ctx.env, ctx.tenant!, p, "default", ctx.now);
    }
    // Apply deltas against the live set, not the earlier read (repository creation also enables repo).
    const result = await ctx.db.prepare(`UPDATE project SET parts = (
      SELECT json_group_array(value) FROM (
        SELECT DISTINCT value FROM json_each(project.parts) WHERE value NOT IN (SELECT value FROM json_each(?))
        UNION SELECT value FROM json_each(?)
      )) WHERE tenant_id = ? AND id = ? AND state = 'active'
      AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'project_delete:v1:' || project.tenant_id || ':' || project.id)
      ${emptyChecks.length ? `AND ${emptyChecks.join(" AND ")}` : ""}
      RETURNING *`).bind(JSON.stringify(v.remove), JSON.stringify(v.add), ctx.tenant!.id, p.id).first<Project>();
    if (!result) throw conflict("project changed; reload and try again");
    await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "project.update", target_kind: "project", target_id: p.id, summary: `Updated parts for ${v.project}: +${v.add.join(",")} -${v.remove.join(",")}` }, ctx.now);
    return { project: { ...result, path: v.project }, parts: projectFeatures(result) };
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
  name: "project.delete", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Delete your own tmp- project with no other human members. Other projects require an admin's fresh web confirmation after archiving.",
  mcp: { scope: "write", destructive: true, title: "Delete throwaway project", input: { type: "object", properties: {
    project: { type: "string", description: "Your throwaway project's path (slug or namespace/slug)." },
  }, required: ["project"], additionalProperties: false } },
  formBack: () => "/archive",
  parse: (i) => {
    const path = optString(i, "project", { max: 127 });
    const parts = path?.split("/");
    if (parts && (parts.length > 2 || parts.some(s => !s))) throw badRequest("invalid project path");
    return { slug: parts?.at(-1) ?? reqString(i, "slug", { max: 63 }), namespace: parts && parts.length === 2 ? parts[0]! : optString(i, "namespace", { max: 63 }), confirm: optString(i, "confirm", { max: 63 }) };
  },
  run: async (ctx, p) => {
    const agent = ctx.identity!.kind === "agent";
    if (!agent) {
      if (ctx.role !== "admin" && ctx.role !== "root") throw new HubError(403, "forbidden");
      if (ctx.authKind !== "cookie" || ctx.session?.kind !== "browser" || ctx.playground) throw new HubError(403, "forbidden", "sign in on the web to delete a project");
      if (ctx.now - ctx.session.last_proof_at > 600_000) throw new HubError(403, "reproof_required");
    }
    const project = await getProjectByPath(ctx.db, ctx.tenant!.id, p.namespace, p.slug);
    if (!project || project.kind === "channel" || project.kind === "agent-src") throw notFound("no such project");
    if (!agent && p.confirm !== project.slug) throw badRequest("type the project slug exactly to confirm");
    return deleteProject(ctx, project, agent);
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
