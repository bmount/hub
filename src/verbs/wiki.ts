import { defineVerb, type McpInputSchema } from "./table";
import { reqString, optString, optInt } from "./params";
import { badRequest, conflict, notFound } from "../errors";
import type { Ctx } from "../auth/context";
import { requireProjectFeature } from "../projectFeatures";

export const WIKI_BODY_BYTES = 131072;
export type WikiRevision = { slug: string; revision: number; title: string; body: string; links: string; note: string; author_id: string; author: string; created_at: number; deleted: number; research: string | null };
export const currentWiki = "r.revision = (SELECT MAX(h.revision) FROM wiki_revision h WHERE h.tenant_id = r.tenant_id AND h.project_id = r.project_id AND h.slug = r.slug)";
export function wikiSlug(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 100) throw badRequest("slug must be lowercase words separated by hyphens (at most 100 characters)");
  return value;
}
export function wikiLinks(body: string): string[] {
  return [...new Set([...body.matchAll(/\[\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g)].map(m => m[1]!).filter(s => s.length <= 100))];
}
export async function wikiProject(ctx: Ctx, slug: string, writing = false) {
  const p = await ctx.db.prepare("SELECT id, slug, kind, state FROM project WHERE tenant_id = ? AND namespace_id IS NULL AND slug = ?").bind(ctx.tenant!.id, slug).first<{id: string; slug: string; kind: string; state: string}>();
  if (!p) throw notFound("no such project");
  requireProjectFeature(p, "wiki");
  if (writing && p.state !== "active") throw conflict("project is archived");
  return p;
}
const properties = { project: {type: "string"}, slug: {type: "string"} };
const input = (extra: Record<string, Record<string, unknown>> = {}, required = ["project", "slug"]): McpInputSchema => ({type: "object", properties: {...properties, ...extra}, required, additionalProperties: false});
const ref = (i: Record<string, unknown>) => ({project: reqString(i, "project", {max: 63}), slug: wikiSlug(reqString(i, "slug", {max: 100}))});
const base = {scope: "tenant", freshProofMinutes: null} as const;
export async function readWiki(ctx: Ctx, project: string, slug: string, revision: number | null = null) {
  const p = await wikiProject(ctx, project);
  const r = await ctx.db.prepare(`SELECT r.*, i.display_name AS author FROM wiki_revision r JOIN identity i ON i.id = r.author_id WHERE r.tenant_id = ? AND r.project_id = ? AND r.slug = ? AND ${revision === null ? currentWiki : "r.revision = ?"}`).bind(ctx.tenant!.id, p.id, slug, ...(revision === null ? [] : [revision])).first<WikiRevision>();
  if (!r || (revision === null && r.deleted)) throw notFound("no such wiki page");
  const backlinks = (await ctx.db.prepare(`SELECT r.slug, r.title FROM wiki_revision r WHERE r.tenant_id = ? AND r.project_id = ? AND ${currentWiki} AND r.deleted = 0 AND EXISTS (SELECT 1 FROM json_each(r.links) WHERE value = ?) ORDER BY r.slug LIMIT 200`).bind(ctx.tenant!.id, p.id, slug).all<{slug: string; title: string}>()).results;
  return {page: {...r, page_type: r.research ? "research" : "kb"}, links: JSON.parse(r.links) as string[], backlinks};
}
export const wikiRead = defineVerb({ ...base, name: "wiki.read", kind: "query", minRole: "reader", summary: "Read a wiki page, its links and backlinks, optionally at a historical revision.", mcp: {scope: "read", destructive: false, title: "Read wiki page", input: input({revision: {type: "integer", minimum: 1}})}, parse: i => ({...ref(i), revision: optInt(i, "revision", {min: 1, max: 2147483647})}), run: (ctx, p) => readWiki(ctx, p.project, p.slug, p.revision) });
export const wikiList = defineVerb({ ...base, name: "wiki.list", kind: "query", minRole: "reader", summary: "List current wiki pages alphabetically, 200 at a time; pass after for the next page.", mcp: {scope: "read", destructive: false, title: "List wiki pages", input: input({after: {type: "string"}}, ["project"])}, parse: i => ({project: reqString(i, "project", {max: 63}), after: optString(i, "after", {max: 100}) ?? ""}), run: async (ctx, v) => {
  const p = await wikiProject(ctx, v.project);
  const rows = (await ctx.db.prepare(`SELECT r.slug, r.title, r.revision, r.created_at, CASE WHEN r.research IS NULL THEN 'kb' ELSE 'research' END AS page_type FROM wiki_revision r WHERE r.tenant_id = ? AND r.project_id = ? AND ${currentWiki} AND r.deleted = 0 AND r.slug > ? ORDER BY r.slug LIMIT 201`).bind(ctx.tenant!.id, p.id, v.after).all<{slug: string; title: string; revision: number; created_at: number; page_type: "kb" | "research"}>()).results;
  return {pages: rows.slice(0, 200), next_cursor: rows.length > 200 ? rows[199]!.slug : null};
} });
export const wikiHistory = defineVerb({ ...base, name: "wiki.history", kind: "query", minRole: "reader", summary: "List wiki revisions, newest first, 200 at a time; pass before for older history. Revert by reading an old revision and writing its title/body with the current expected_revision.", mcp: {scope: "read", destructive: false, title: "Wiki history", input: input({before: {type: "integer", minimum: 1}})}, parse: i => ({...ref(i), before: optInt(i, "before", {min: 1, max: 2147483647}) ?? 2147483648}), run: async (ctx, v) => {
  const p = await wikiProject(ctx, v.project);
  const rows = (await ctx.db.prepare("SELECT r.revision, r.title, r.note, r.author_id, i.display_name AS author, r.created_at, r.deleted FROM wiki_revision r JOIN identity i ON i.id = r.author_id WHERE r.tenant_id = ? AND r.project_id = ? AND r.slug = ? AND r.revision < ? ORDER BY r.revision DESC LIMIT 201").bind(ctx.tenant!.id, p.id, v.slug, v.before).all<Omit<WikiRevision, "body" | "links" | "slug">>()).results;
  return {history: rows.slice(0, 200), next_cursor: rows.length > 200 ? rows[199]!.revision : null};
} });
export async function appendWiki(ctx: Ctx, v: {project: string; slug: string; expected_revision: number; title: string; body: string; note: string; research?: string | null}, deleted = false) {
  const p = await wikiProject(ctx, v.project, true);
  const head = await ctx.db.prepare(`SELECT research FROM wiki_revision r WHERE tenant_id = ? AND project_id = ? AND slug = ? AND ${currentWiki}`).bind(ctx.tenant!.id, p.id, v.slug).first<{research: string | null}>();
  if (!deleted && head?.research && !v.research) throw conflict("research pages must be revised with research.save");
  if (!deleted && head && !head.research && v.research) throw conflict("a KB page cannot be replaced by research");
  // The comparison and append are one SQL statement, so concurrent writers cannot both win.
  const result = await ctx.db.prepare(`INSERT INTO wiki_revision (tenant_id, project_id, slug, revision, title, body, links, note, author_id, created_at, deleted, research)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE COALESCE((SELECT MAX(revision) FROM wiki_revision WHERE tenant_id = ? AND project_id = ? AND slug = ?), 0) = ?`).bind(ctx.tenant!.id, p.id, v.slug, v.expected_revision + 1, v.title, v.body, JSON.stringify(wikiLinks(v.body)), v.note, ctx.identity!.id, ctx.now, deleted ? 1 : 0, v.research ?? null, ctx.tenant!.id, p.id, v.slug, v.expected_revision).run();
  if (!result.meta.changes) throw conflict("stale wiki edit: read the latest revision before writing");
  return {project: v.project, slug: v.slug, revision: v.expected_revision + 1, deleted};
}
const expected = (i: Record<string, unknown>) => {
  const n = optInt(i, "expected_revision", {min: 0, max: 2147483646});
  if (n === null) throw badRequest("expected_revision is required (0 for a new page)");
  return n;
};
export const wikiWrite = defineVerb({ ...base, name: "wiki.write", kind: "command", minRole: "member", summary: "Create or revise a Markdown wiki page. expected_revision is required: 0 for a new page, current revision otherwise. Bodies are limited to 128 KiB UTF-8. Old revisions are retained.", formBack: (r: {project: string; slug: string}) => `/${r.project}/wiki/${r.slug}`, mcp: {scope: "write", destructive: false, auditKeysOnly: true, title: "Write wiki page", input: input({expected_revision: {type: "integer", minimum: 0}, title: {type: "string"}, body: {type: "string"}, note: {type: "string"}}, ["project", "slug", "expected_revision", "title", "body", "note"])}, parse: i => {
  if (typeof i.body !== "string" || new TextEncoder().encode(i.body).length > WIKI_BODY_BYTES) throw badRequest("body must be text of at most 128 KiB UTF-8");
  return {...ref(i), expected_revision: expected(i), title: reqString(i, "title", {max: 200}), body: i.body, note: reqString(i, "note", {max: 500})};
}, run: (ctx, v) => appendWiki(ctx, v) });
export const wikiDelete = defineVerb({ ...base, name: "wiki.delete", kind: "command", minRole: "admin", summary: "Remove a wiki page from the current list and search (admin). Its revision history is retained.", mcp: {scope: "write", destructive: true, title: "Delete wiki page", input: input({expected_revision: {type: "integer", minimum: 1}, note: {type: "string"}}, ["project", "slug", "expected_revision", "note"])}, parse: i => ({...ref(i), expected_revision: expected(i), note: reqString(i, "note", {max: 500})}), run: async (ctx, v) => {
  const {page} = await readWiki(ctx, v.project, v.slug);
  return appendWiki(ctx, {...v, title: page.title, body: page.body, research: page.research}, true);
} });
export const wikiVerbs = [wikiList, wikiRead, wikiWrite, wikiHistory, wikiDelete];
