import { defineVerb, type McpInputSchema } from "./table";
import { reqString, optString, optInt, reqEnum } from "./params";
import { badRequest, notFound } from "../errors";
import { appendWiki, currentWiki, wikiProject, wikiSlug, WIKI_BODY_BYTES } from "./wiki";
import { requireProjectFeature } from "../projectFeatures";
import { filePath } from "./files";
import type { Ctx } from "../auth/context";

export type Research = { topic: string; summary: string; status: "draft" | "final"; sources: Array<{url?: string; file?: string; title: string; retrieved_at: string; quote: string}>; people: string[]; orgs: string[]; items: string[] };
const base = {scope: "tenant", freshProofMinutes: null} as const;
const string = {type: "string"};
const array = {type: "array", items: string, maxItems: 50};
const schema = (properties: Record<string, Record<string, unknown>>, required: string[]): McpInputSchema => ({type: "object", properties, required, additionalProperties: false});
function refs(i: Record<string, unknown>, key: string): string[] {
  const value = i[key] ?? [];
  if (!Array.isArray(value) || value.length > 50 || value.some(v => typeof v !== "string" || !v.trim() || v.length > 200)) throw badRequest(`${key} must be up to 50 nonempty references`);
  return [...new Set(value)] as string[];
}
async function workspace(ctx: Ctx, project: string, writing = false) {
  const p = await wikiProject(ctx, project, writing);
  requireProjectFeature(p, "knowledge");
  return p;
}
export const researchSave = defineVerb({ ...base, name: "research.save", kind: "command", minRole: "member",
  summary: "Save a research page in a workspace's wiki revision store. Author is the caller. Use expected_revision=0 to create, current revision to revise. People are organization member identity IDs; orgs are named external organization references; items are tenant-local project#number references. File sources are paths in this workspace. No URLs are fetched.",
  mcp: {scope: "write", destructive: false, auditKeysOnly: true, title: "Save research", input: schema({project: string, slug: string, expected_revision: {type: "integer", minimum: 0}, topic: string, summary: string, status: {type: "string", enum: ["draft", "final"]}, sources: {type: "array", maxItems: 50, items: {type: "object", properties: {url: string, file: string, title: string, retrieved_at: string, quote: string}, required: ["title", "retrieved_at", "quote"], additionalProperties: false}}, people: array, orgs: array, items: array, note: string}, ["project", "slug", "expected_revision", "topic", "summary", "status", "sources", "note"])},
  parse: i => {
    const expected_revision = optInt(i, "expected_revision", {min: 0, max: 2147483646});
    if (expected_revision === null) throw badRequest("expected_revision is required");
    if (!Array.isArray(i.sources) || i.sources.length > 50) throw badRequest("sources must be an array of at most 50 sources");
    const sources = i.sources.map(s => {
      if (!s || typeof s !== "object" || Array.isArray(s)) throw badRequest("invalid source");
      const r = s as Record<string, unknown>;
      const url = optString(r, "url", {max: 2048});
      const file = optString(r, "file", {max: 500});
      if (!!url === !!file) throw badRequest("source needs exactly one URL or file");
      if (url) { let u: URL; try { u = new URL(url); } catch { throw badRequest("invalid source URL"); } if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw badRequest("source URL must be HTTP(S) without credentials"); }
      const retrieved_at = reqString(r, "retrieved_at", {max: 40});
      if (!/^\d{4}-\d{2}-\d{2}T/.test(retrieved_at) || !Number.isFinite(Date.parse(retrieved_at))) throw badRequest("retrieved_at must be an ISO timestamp");
      return {...(url ? {url} : {file: filePath(file!)}), title: reqString(r, "title", {max: 200}), retrieved_at, quote: reqString(r, "quote", {max: 10000})};
    });
    const research: Research = {topic: reqString(i, "topic", {max: 200}), summary: reqString(i, "summary", {max: 50000}), status: reqEnum(i, "status", ["draft", "final"]), sources, people: refs(i, "people"), orgs: refs(i, "orgs"), items: refs(i, "items")};
    if (new TextEncoder().encode(JSON.stringify(research)).length > WIKI_BODY_BYTES / 2) throw badRequest("research exceeds 64 KiB");
    return {project: reqString(i, "project", {max: 127}), slug: wikiSlug(reqString(i, "slug", {max: 100})), expected_revision, note: reqString(i, "note", {max: 500}), research};
  }, run: async (ctx, v) => {
    const p = await workspace(ctx, v.project, true);
    for (const id of v.research.people) {
      if (!await ctx.db.prepare("SELECT 1 FROM membership WHERE tenant_id = ? AND identity_id = ? AND state = 'active'").bind(ctx.tenant!.id, id).first()) throw notFound("no such organization person");
    }
    for (const ref of v.research.items) {
      const m = /^([a-z0-9]+(?:-[a-z0-9]+)*)#([1-9][0-9]*)$/.exec(ref);
      if (!m || !await ctx.db.prepare("SELECT 1 FROM work_item w JOIN project p ON p.id = w.project_id AND p.tenant_id = w.tenant_id WHERE w.tenant_id = ? AND p.slug = ? AND w.number = ?").bind(ctx.tenant!.id, m[1], Number(m[2])).first()) throw notFound("no such organization item");
    }
    for (const s of v.research.sources) if (s.file && !await ctx.db.prepare("SELECT 1 FROM file_revision r WHERE tenant_id = ? AND project_id = ? AND path = ? AND revision = (SELECT MAX(h.revision) FROM file_revision h WHERE h.tenant_id = r.tenant_id AND h.project_id = r.project_id AND h.path = r.path) AND deleted = 0").bind(ctx.tenant!.id, p.id, s.file).first()) throw notFound("no such workspace file");
    // A text projection keeps all structured fields in the existing wiki search index.
    const body = `${v.research.summary}\n\nStatus: ${v.research.status}\n\nSources\n${v.research.sources.map(s => `${s.title}\n${s.url ?? s.file}\nRetrieved: ${s.retrieved_at}\n${s.quote}`).join("\n\n")}\n\nPeople: ${v.research.people.join(", ")}\nOrganizations: ${v.research.orgs.join(", ")}\nItems: ${v.research.items.join(", ")}`;
    return appendWiki(ctx, {...v, title: v.research.topic, body, research: JSON.stringify(v.research)});
  }
});
export const researchList = defineVerb({ ...base, name: "research.list", kind: "query", minRole: "reader", summary: "List current research pages in a workspace, with topic substring, linked person identity ID, named organization and status filters. Alphabetical, 200 per page; pass after to continue.", mcp: {scope: "read", destructive: false, title: "List research", input: schema({project: string, topic: string, person: string, org: string, status: {type: "string", enum: ["draft", "final"]}, after: string}, ["project"])}, parse: i => {
  const status = optString(i, "status");
  if (status && !["draft", "final"].includes(status)) throw badRequest("status must be draft or final");
  return {project: reqString(i, "project", {max: 127}), topic: optString(i, "topic", {max: 200}), person: optString(i, "person", {max: 200}), org: optString(i, "org", {max: 200}), status, after: optString(i, "after", {max: 100}) ?? ""};
}, run: async (ctx, v) => {
  const p = await workspace(ctx, v.project);
  const clauses = ["r.tenant_id = ?", "r.project_id = ?", currentWiki, "r.deleted = 0", "r.research IS NOT NULL", "r.slug > ?"];
  const args: (string | number)[] = [ctx.tenant!.id, p.id, v.after];
  if (v.topic) {clauses.push("instr(lower(json_extract(r.research, '$.topic')), lower(?)) > 0"); args.push(v.topic);}
  if (v.status) {clauses.push("json_extract(r.research, '$.status') = ?"); args.push(v.status);}
  for (const [key, value] of [["people", v.person], ["orgs", v.org]] as const) if (value) {clauses.push(`EXISTS (SELECT 1 FROM json_each(r.research, '$.${key}') WHERE value = ?)`); args.push(value);}
  const rows = (await ctx.db.prepare(`SELECT r.slug, r.revision, r.research, r.author_id, i.display_name AS author, r.created_at FROM wiki_revision r JOIN identity i ON i.id = r.author_id WHERE ${clauses.join(" AND ")} ORDER BY r.slug LIMIT 201`).bind(...args).all<{slug: string; revision: number; research: string; author_id: string; author: string; created_at: number}>()).results;
  return {results: rows.slice(0, 200).map(({research, ...r}) => ({...r, ...JSON.parse(research) as Research})), next_cursor: rows.length > 200 ? rows[199]!.slug : null};
}});
export const researchVerbs = [researchSave, researchList];
