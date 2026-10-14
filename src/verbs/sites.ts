import type { Ctx } from "../auth/context";
import { defineVerb } from "./table";
import { reqString, optString } from "./params";
import { featureProject } from "./featureProject";
import { badRequest, conflict, notFound } from "../errors";
import { recordEvent } from "../db/events";
import { ulid } from "../ids";
import { DATA_NOTE } from "../mcp/render";
import { currentDeployStatement, deployView, type DeployRow } from "../apps/deploy";

export type SiteRow = { id: string; tenant_id: string; project_id: string; name: string; hostnames: string; project: string };
export async function findSite(ctx: Ctx, name: string): Promise<SiteRow> {
  const row = await ctx.db.prepare(`/*perf-site:src%2Fverbs%2Fsites.ts:13:21:row*/ SELECT s.*, p.slug AS project FROM site s JOIN project p ON p.id = s.project_id AND p.tenant_id = s.tenant_id
    WHERE s.tenant_id = ? AND s.name = ? AND p.kind NOT IN ('channel','agent-src') AND (? IS NULL OR p.id = ?)`)
    .bind(ctx.tenant!.id, name, ctx.mcpProject?.id ?? null, ctx.mcpProject?.id ?? null).first<SiteRow>();
  if (!row) throw notFound("no such site");
  return row;
}

export async function siteView(ctx: Ctx, row: SiteRow) {
  const apps = (await ctx.db.prepare(`/*perf-site:src%2Fverbs%2Fsites.ts:21:23:apps*/ SELECT a.id, a.script_name, a.state FROM site_app sa JOIN app_source a ON a.id = sa.app_id
    WHERE sa.site_id = ? AND a.tenant_id = ? AND a.project_id = ? ORDER BY a.script_name`)
    .bind(row.id, ctx.tenant!.id, row.project_id).all<{ id: string; script_name: string; state: string }>()).results;
  const versions = apps.length ? await ctx.db.batch(apps.map(a => currentDeployStatement(ctx, row.project_id, a.script_name))) : [];
  return { id: row.id, name: row.name, hostnames: JSON.parse(row.hostnames) as string[], project: row.project,
    apps: apps.map((a, i) => {
      const d = versions[i]?.results[0] as DeployRow | undefined;
      const view = d ? deployView(d) : null;
      return { script: a.script_name, state: a.state, currentVersion: view?.release ? {
        id: view.release.version as string, deployment: view.release.deployment as string,
        deployRecord: view.deploy.id, recordedAt: view.deploy.seen_at, commitRef: view.commitRef, commitHref: view.commitHref,
        source: "recorded-production-deploy" as const,
      } : null };
    }),
    versionNote: "Current versions are the latest recorded production deployments, not a live Cloudflare rollout check. Unknown commits remain null.",
  };
}

export const siteList = defineVerb({
  name: "site.list", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Sites run a project's code: hostnames, registered Workers and latest recorded production versions linked to deploy records and commits. Records are not proof of live rollout.",
  mcp: { scope: "read", destructive: false, title: "Sites", input: { type: "object", properties: { project: { type: "string" } }, additionalProperties: false }, render: r => `${DATA_NOTE}\n\n${JSON.stringify(r, null, 2)}` },
  parse: i => ({ project: optString(i, "project", { max: 127 }) }),
  run: async (ctx, p) => {
    const pr = p.project ? await featureProject(ctx, p.project) : ctx.mcpProject;
    const rows = (await ctx.db.prepare(`/*perf-site:src%2Fverbs%2Fsites.ts:46:25:rows*/ SELECT s.*, p.slug AS project FROM site s JOIN project p ON p.id = s.project_id AND p.tenant_id = s.tenant_id
      WHERE s.tenant_id = ? AND p.kind NOT IN ('channel','agent-src') AND (? IS NULL OR s.project_id = ?) ORDER BY s.name`)
      .bind(ctx.tenant!.id, pr?.id ?? null, pr?.id ?? null).all<SiteRow>()).results;
    return { sites: await Promise.all(rows.map(row => siteView(ctx, row))) };
  },
});

export const siteRead = defineVerb({
  name: "site.read", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "One site by name, its registered Workers and latest recorded production versions with deploy/commit links. Tenant and project scoped; not a live rollout check.",
  mcp: { scope: "read", destructive: false, title: "Read a site", input: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }, render: r => `${DATA_NOTE}\n\n${JSON.stringify(r, null, 2)}` },
  parse: i => ({ name: reqString(i, "name", { max: 253 }).toLowerCase() }),
  run: async (ctx, p) => ({ site: await siteView(ctx, await findSite(ctx, p.name)) }),
});

export const siteRegister = defineVerb({
  name: "site.register", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Name a project's site and attach existing registered apps. This does not register, approve, enable or move Workers; use app_register and its existing approval rules first.",
  mcp: { scope: "write", destructive: false, title: "Register a site", input: { type: "object", properties: { project: { type: "string" }, name: { type: "string" }, hostnames: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 }, apps: { type: "array", items: { type: "string" }, maxItems: 20 } }, required: ["project", "name", "hostnames", "apps"], additionalProperties: false }, render: r => `${DATA_NOTE}\n\n${JSON.stringify(r, null, 2)}` },
  parse: i => {
    const name = reqString(i, "name", { max: 253 }).toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) throw badRequest("name must be a hostname");
    if (!Array.isArray(i.hostnames) || !i.hostnames.length || i.hostnames.length > 20 || i.hostnames.some(h => typeof h !== "string" || h.length > 253 || !/^(\*\.)?[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(h))) throw badRequest("hostnames must be lowercase hostnames, optionally with a wildcard prefix");
    if (!Array.isArray(i.apps) || i.apps.length > 20 || i.apps.some(a => typeof a !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(a))) throw badRequest("apps must be Worker names");
    return { project: reqString(i, "project", { max: 127 }), name, hostnames: [...new Set(i.hostnames as string[])], apps: [...new Set(i.apps as string[])] };
  },
  run: async (ctx, p) => {
    const pr = await featureProject(ctx, p.project);
    if (pr.kind !== "repo") throw badRequest("sites require a code project");
    const prior = await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fsites.ts:75:25:prior*/ SELECT id, project_id FROM site WHERE tenant_id = ? AND name = ?").bind(ctx.tenant!.id, p.name).first<{ id: string; project_id: string }>();
    if (prior && prior.project_id !== pr.id) throw conflict("site belongs to another project");
    const apps = (await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fsites.ts:77:25:apps*/ SELECT id, script_name FROM app_source WHERE tenant_id = ? AND project_id = ?").bind(ctx.tenant!.id, pr.id).all<{ id: string; script_name: string }>()).results;
    const ids = p.apps.map(script => { const a = apps.find(a => a.script_name === script); if (!a) throw badRequest("every app must already be registered to this project"); return a.id; });
    const id = prior?.id ?? ulid(ctx.now);
    await ctx.db.batch([
      ctx.db.prepare("/*perf-site:src%2Fverbs%2Fsites.ts:81:7:siteRegister*/ INSERT INTO site (id, tenant_id, project_id, name, hostnames, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, name) DO UPDATE SET hostnames = excluded.hostnames").bind(id, ctx.tenant!.id, pr.id, p.name, JSON.stringify(p.hostnames), ctx.now),
      ctx.db.prepare("/*perf-site:src%2Fverbs%2Fsites.ts:82:7:siteRegister*/ DELETE FROM site_app WHERE site_id = ?").bind(id),
      ...ids.map(app => ctx.db.prepare("/*perf-site:src%2Fverbs%2Fsites.ts:83:25:siteRegister*/ INSERT INTO site_app (site_id, app_id) VALUES (?, ?)").bind(id, app)),
    ]);
    await recordEvent(ctx.db, {tenant_id:ctx.tenant!.id,identity_id:ctx.identity!.id,session_id:ctx.session?.id ?? null,kind:"site.register",target_kind:"project",target_id:pr.id,summary:`Registered site ${p.name} with ${ids.length} apps`}, ctx.now);
    return { site: await siteView(ctx, await findSite(ctx, p.name)) };
  },
});
