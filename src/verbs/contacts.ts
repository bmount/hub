import { defineVerb, type McpInputSchema } from "./table";
import { reqString, optString, optInt, reqEnum } from "./params";
import { badRequest, conflict, notFound } from "../errors";
import { wikiProject, currentWiki } from "./wiki";
import { currentFile, filePath } from "./files";
import { requireProjectFeature } from "../projectFeatures";
import { readableMail } from "../auth/mailAccess";
import type { Ctx } from "../auth/context";
import { ulid } from "../ids";

const base = {scope: "tenant", freshProofMinutes: null} as const;
const str = {type: "string"};
const strings = {type: "array", items: str, maxItems: 50};
const linkSchema = {type: "array", maxItems: 50, items: {type: "object", properties: {kind: {type: "string", enum: ["item", "research", "file", "mail"]}, ref: str}, required: ["kind", "ref"], additionalProperties: false}};
const schema = (extra: Record<string, Record<string, unknown>>, required = ["project"]): McpInputSchema => ({type: "object", properties: {project: str, ...extra}, required, additionalProperties: false});
const projectRef = (i: Record<string, unknown>) => ({project: reqString(i, "project", {max: 127})});
const entityRef = (i: Record<string, unknown>) => ({...projectRef(i), id: reqString(i, "id", {max: 100})});
export type Contact = {id: string; kind: "person" | "company"; name: string; data: string; revision: number; updated_at: number};
export type Connection = {id: string; a: string; b: string; type: string; strength: number | null; source: string; date: string};
type Link = {kind: "item" | "research" | "file" | "mail"; ref: string};
export async function contactProject(ctx: Ctx, slug: string, writing = false) {
  const p = await wikiProject(ctx, slug, writing);
  requireProjectFeature(p, "people");
  return p;
}
async function entity(ctx: Ctx, pid: string, id: string, kind?: string) {
  const r = await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:27:19:entity:93e834f6*/ SELECT id, kind, name, data, revision, updated_at FROM contact_entity WHERE tenant_id = ? AND project_id = ? AND id = ?").bind(ctx.tenant!.id, pid, id).first<Contact>();
  if (!r || (kind && r.kind !== kind)) throw notFound("no such workspace contact");
  return r;
}
function list(i: Record<string, unknown>, key: string): string[] {
  const v = i[key] ?? [];
  if (!Array.isArray(v) || v.length > 50 || v.some(x => typeof x !== "string" || !x.trim() || x.length > 200)) throw badRequest(`${key} must be up to 50 nonempty strings`);
  return [...new Set(v.map(x => (x as string).trim()))];
}
function links(i: Record<string, unknown>): Link[] | null {
  if (i.links === undefined) return null;
  if (!Array.isArray(i.links) || i.links.length > 50) throw badRequest("links must be up to 50 references");
  return i.links.map(x => {
    if (!x || typeof x !== "object" || Array.isArray(x)) throw badRequest("invalid link");
    const r = x as Record<string, unknown>;
    return {kind: reqEnum(r, "kind", ["item", "research", "file", "mail"]), ref: reqString(r, "ref", {max: 500})};
  });
}
async function visibleLink(ctx: Ctx, pid: string, l: Link): Promise<{kind: string; ref: string; title: string; href: string} | null> {
  const tid = ctx.tenant!.id;
  if (l.kind === "item") {
    const r = await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:48:21:visibleLink:5f5edb69*/ SELECT w.number, w.title, CASE WHEN p.namespace_id IS NULL THEN p.slug ELSE (SELECT slug FROM namespace WHERE id = p.namespace_id AND tenant_id = p.tenant_id) || '/' || p.slug END AS slug FROM work_item w JOIN project p ON p.id = w.project_id AND p.tenant_id = w.tenant_id WHERE w.tenant_id = ? AND w.project_id = ? AND w.id = ?").bind(tid, pid, l.ref).first<{number: number; title: string; slug: string}>();
    return r ? {...l, title: r.title, href: `/${r.slug}/w/${r.number}`} : null;
  }
  if (l.kind === "mail") {
    const access = readableMail(ctx);
    const r = await ctx.db.prepare(`/*perf-site:src%2Fverbs%2Fcontacts.ts:53:21:visibleLink:bd558442*/ SELECT m.subject FROM inbound_mail m WHERE m.id = ? AND ${access.sql}`).bind(l.ref, ...access.bindings).first<{subject: string}>();
    return r ? {...l, title: r.subject, href: `/mail/${encodeURIComponent(l.ref)}`} : null;
  }
  if (l.kind === "research") {
    const r = await ctx.db.prepare(`/*perf-site:src%2Fverbs%2Fcontacts.ts:57:21:visibleLink:79c95985*/ SELECT r.title, CASE WHEN p.namespace_id IS NULL THEN p.slug ELSE (SELECT slug FROM namespace WHERE id = p.namespace_id AND tenant_id = p.tenant_id) || '/' || p.slug END AS slug FROM wiki_revision r JOIN project p ON p.id = r.project_id AND p.tenant_id = r.tenant_id WHERE r.tenant_id = ? AND r.project_id = ? AND r.slug = ? AND ${currentWiki} AND r.deleted = 0 AND r.research IS NOT NULL`).bind(tid, pid, l.ref).first<{title: string; slug: string}>();
    return r ? {...l, title: r.title, href: `/${r.slug}/wiki/${encodeURIComponent(l.ref)}`} : null;
  }
  const r = await ctx.db.prepare(`/*perf-site:src%2Fverbs%2Fcontacts.ts:60:19:visibleLink:87ecdab6*/ SELECT r.name, CASE WHEN p.namespace_id IS NULL THEN p.slug ELSE (SELECT slug FROM namespace WHERE id = p.namespace_id AND tenant_id = p.tenant_id) || '/' || p.slug END AS slug FROM file_revision r JOIN project p ON p.id = r.project_id AND p.tenant_id = r.tenant_id WHERE r.tenant_id = ? AND r.project_id = ? AND r.path = ? AND ${currentFile} AND r.deleted = 0`).bind(tid, pid, filePath(l.ref)).first<{name: string; slug: string}>();
  return r ? {...l, title: r.name, href: `/${r.slug}/documents?path=${encodeURIComponent(l.ref)}`} : null;
}
async function backlinks(ctx: Ctx, pid: string, id: string) {
  const rows = (await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:64:23:backlinks:3bc393ae*/ SELECT kind, ref FROM contact_link WHERE tenant_id = ? AND project_id = ? AND entity_id = ? ORDER BY kind, ref LIMIT 201").bind(ctx.tenant!.id, pid, id).all<Link>()).results;
  // Mail references, including identifiers, remain private to readers of that mailbox.
  const visible = await Promise.all(rows.slice(0, 200).map(l => visibleLink(ctx, pid, l)));
  return visible.filter((x): x is NonNullable<typeof x> => x !== null);
}
const unpack = (r: Contact) => {const {data, ...rest} = r; return {...rest, ...JSON.parse(data) as Record<string, unknown>};};
function upsert(kind: "person" | "company") {
  const fields: Record<string, Record<string, unknown>> = kind === "person" ? {emails: strings, phones: strings, title: str} : {domain: str, stage: str, sector: str};
  return defineVerb({...base, name: `${kind}.upsert`, kind: "command", minRole: "member", summary: `Create or replace a workspace ${kind} contact (not a Pimwell identity). Omit id to create; updating requires expected_revision from read. Links replace the caller-visible backlinks only when supplied: item ID, research slug, file path, or readable mail ID. Use connection.add between person and company with type=role for company affiliations.`,
    mcp: {scope: "write", destructive: false, auditKeysOnly: true, title: `Save ${kind}`, input: schema({id: str, expected_revision: {type: "integer", minimum: 1}, name: str, ...fields, notes: str, tags: strings, links: linkSchema}, ["project", "name"])},
    formBack: (r: {project: string; entity: {id: string}}) => `/${r.project}/contacts/${r.entity.id}`,
    parse: i => {
      const id = optString(i, "id", {max: 100});
      const revision = optInt(i, "expected_revision", {min: 1, max: 2147483646});
      if (id && revision === null) throw badRequest("updating requires expected_revision");
      if (!id && revision !== null) throw badRequest("expected_revision requires an existing contact id");
      const data: Record<string, unknown> = {notes: optString(i, "notes", {max: 50000}) ?? "", tags: list(i, "tags")};
      for (const f of kind === "person" ? ["emails", "phones"] : []) data[f] = list(i, f);
      for (const f of kind === "person" ? ["title"] : ["domain", "stage", "sector"]) data[f] = optString(i, f, {max: 200}) ?? "";
      return {...projectRef(i), id, revision, name: reqString(i, "name", {max: 200}), data, links: links(i)};
    }, run: async (ctx, v) => {
      const p = await contactProject(ctx, v.project, true), tid = ctx.tenant!.id;
      if (v.id) await entity(ctx, p.id, v.id, kind);
      for (const l of v.links ?? []) if (!await visibleLink(ctx, p.id, l)) throw notFound("no such readable workspace link");
      const id = v.id ?? ulid(ctx.now);
      const statements = [v.id ? ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:89:34:run:b8e606cb*/ UPDATE contact_entity SET name = ?, data = CASE WHEN revision = ? THEN ? ELSE NULL END, revision = revision + 1, updated_at = ? WHERE tenant_id = ? AND project_id = ? AND id = ?").bind(v.name, v.revision, JSON.stringify(v.data), ctx.now, tid, p.id, id) : ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:89:364:run:191a477b*/ INSERT INTO contact_entity (tenant_id, project_id, id, kind, name, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(tid, p.id, id, kind, v.name, JSON.stringify(v.data), ctx.now)];
      if (v.links !== null) {
        const mail = readableMail(ctx);
        // Replace all readable associations, not just the first page; preserve private mailbox links.
        statements.push(ctx.db.prepare(`/*perf-site:src%2Fverbs%2Fcontacts.ts:93:25:run:b7f6ccb6*/ DELETE FROM contact_link WHERE tenant_id = ? AND project_id = ? AND entity_id = ? AND (kind <> 'mail' OR EXISTS (SELECT 1 FROM inbound_mail m WHERE m.id = contact_link.ref AND ${mail.sql})) AND EXISTS (SELECT 1 FROM contact_entity WHERE tenant_id = ? AND project_id = ? AND id = ? AND revision = ?)`).bind(tid, p.id, id, ...mail.bindings, tid, p.id, id, (v.revision ?? 0) + 1));
        for (const l of v.links) statements.push(ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:94:50:run:9c388111*/ INSERT OR IGNORE INTO contact_link (tenant_id, project_id, entity_id, kind, ref) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM contact_entity WHERE tenant_id = ? AND project_id = ? AND id = ? AND revision = ?)").bind(tid, p.id, id, l.kind, l.ref, tid, p.id, id, (v.revision ?? 0) + 1));
      }
      const results = await ctx.db.batch(statements).catch((e: unknown) => {if (String(e).includes("NOT NULL")) throw conflict("stale contact edit: read before writing"); throw e;});
      if (!results[0]!.meta.changes) throw conflict("stale contact edit: read before writing");
      return {project: v.project, entity: unpack(await entity(ctx, p.id, id, kind)), backlinks: await backlinks(ctx, p.id, id)};
    }});
}
function read(kind: "person" | "company") {
  return defineVerb({...base, name: `${kind}.read`, kind: "query", minRole: "reader", summary: `Read a workspace ${kind} and readable content backlinks.`, mcp: {scope: "read", destructive: false, title: `Read ${kind}`, input: schema({id: str}, ["project", "id"])}, parse: entityRef, run: async (ctx, v) => {
    const p = await contactProject(ctx, v.project);
    return {entity: unpack(await entity(ctx, p.id, v.id, kind)), backlinks: await backlinks(ctx, p.id, v.id)};
  }});
}
function contactList(kind: "person" | "company") {
  return defineVerb({...base, name: `${kind}.list`, kind: "query", minRole: "reader", summary: `List workspace ${kind} contacts, optionally by name substring or tag; 200/page, ordered by ID.`, mcp: {scope: "read", destructive: false, title: `List ${kind} contacts`, input: schema({q: str, tag: str, after: str})}, parse: i => ({...projectRef(i), q: optString(i, "q", {max: 200}) ?? "", tag: optString(i, "tag", {max: 200}), after: optString(i, "after", {max: 100}) ?? ""}), run: async (ctx, v) => {
    const p = await contactProject(ctx, v.project);
    const rows = (await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:110:25:run:e23eb9e0*/ SELECT id, kind, name, data, revision, updated_at FROM contact_entity WHERE tenant_id = ? AND project_id = ? AND kind = ? AND id > ? AND instr(lower(name), lower(?)) > 0 AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(data, '$.tags') WHERE value = ?)) ORDER BY id LIMIT 201").bind(ctx.tenant!.id, p.id, kind, v.after, v.q, v.tag, v.tag).all<Contact>()).results;
    return {entities: rows.slice(0, 200).map(unpack), next_cursor: rows.length > 200 ? rows[199]!.id : null};
  }});
}
export const personUpsert = upsert("person"), companyUpsert = upsert("company");
export const personRead = read("person"), companyRead = read("company");
export const personList = contactList("person"), companyList = contactList("company");
export const connectionAdd = defineVerb({...base, name: "connection.add", kind: "command", minRole: "member", summary: "Add an undirected typed connection between workspace contacts. Person-company types can be affiliation roles (founder, advisor, etc). Source is a research reference or note; do not copy private mailbox content into shared sources.", mcp: {scope: "write", destructive: false, auditKeysOnly: true, title: "Add connection", input: schema({a: str, b: str, type: str, strength: {type: "number", minimum: 0, maximum: 1}, source: str, date: str}, ["project", "a", "b", "type"])}, parse: i => {
  const strength = i.strength ?? null;
  if (strength !== null && (typeof strength !== "number" || !Number.isFinite(strength) || strength < 0 || strength > 1)) throw badRequest("strength must be between 0 and 1");
  const date = optString(i, "date", {max: 10});
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw badRequest("date must be YYYY-MM-DD");
  const a = reqString(i, "a", {max: 100}), b = reqString(i, "b", {max: 100});
  if (a === b) throw badRequest("connection requires two different contacts");
  return {...projectRef(i), a, b, type: reqString(i, "type", {max: 100}), strength: strength as number | null, source: optString(i, "source", {max: 2000}) ?? "", date};
}, run: async (ctx, v) => {
  const p = await contactProject(ctx, v.project, true);
  await entity(ctx, p.id, v.a); await entity(ctx, p.id, v.b);
  const c = {id: ulid(ctx.now), a: v.a, b: v.b, type: v.type, strength: v.strength, source: v.source, date: v.date ?? new Date(ctx.now).toISOString().slice(0, 10)};
  await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:129:9:connectionAdd.run:e478846b*/ INSERT INTO contact_connection (tenant_id, project_id, id, a, b, type, strength, source, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(ctx.tenant!.id, p.id, c.id, c.a, c.b, c.type, c.strength, c.source, c.date).run();
  return {connection: c};
}});
export const connectionRemove = defineVerb({...base, name: "connection.remove", kind: "command", minRole: "member", summary: "Remove a workspace contact connection by ID.", mcp: {scope: "write", destructive: false, title: "Remove connection", input: schema({id: str}, ["project", "id"])}, parse: entityRef, run: async (ctx, v) => {
  const p = await contactProject(ctx, v.project, true);
  const r = await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:134:19:connectionRemove.run:ce7e35a0*/ DELETE FROM contact_connection WHERE tenant_id = ? AND project_id = ? AND id = ?").bind(ctx.tenant!.id, p.id, v.id).run();
  if (!r.meta.changes) throw notFound("no such connection");
  return {removed: v.id};
}});
export const connectionList = defineVerb({...base, name: "connection.list", kind: "query", minRole: "reader", summary: "List workspace connections, optionally incident to an entity or of a type; 200/page.", mcp: {scope: "read", destructive: false, title: "List connections", input: schema({entity: str, type: str, after: str})}, parse: i => ({...projectRef(i), entity: optString(i, "entity", {max: 100}), type: optString(i, "type", {max: 100}), after: optString(i, "after", {max: 100}) ?? ""}), run: async (ctx, v) => {
  const p = await contactProject(ctx, v.project);
  if (v.entity) await entity(ctx, p.id, v.entity);
  const rows = (await ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:141:23:connectionList.run:886498de*/ SELECT id, a, b, type, strength, source, date FROM contact_connection WHERE tenant_id = ? AND project_id = ? AND id > ? AND (? IS NULL OR a = ? OR b = ?) AND (? IS NULL OR type = ?) ORDER BY id LIMIT 201").bind(ctx.tenant!.id, p.id, v.after, v.entity, v.entity, v.entity, v.type, v.type).all<Connection>()).results;
  return {connections: rows.slice(0, 200), next_cursor: rows.length > 200 ? rows[199]!.id : null};
}});
async function graph(ctx: Ctx, project: string) {
  const p = await contactProject(ctx, project);
  const [nodes, edges] = await ctx.db.batch([ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:146:46:graph:f0aabeae*/ SELECT id, kind, name, data, revision, updated_at FROM contact_entity WHERE tenant_id = ? AND project_id = ? ORDER BY id LIMIT 2001").bind(ctx.tenant!.id, p.id), ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:146:286:graph:46acf70d*/ SELECT id, a, b, type, strength, source, date FROM contact_connection WHERE tenant_id = ? AND project_id = ? ORDER BY id LIMIT 10001").bind(ctx.tenant!.id, p.id)]);
  // Refuse oversized graphs rather than returning a false shortest path.
  if (nodes!.results.length > 2000 || edges!.results.length > 10000) throw badRequest("graph exceeds traversal limit (2000 entities, 10000 connections)");
  return {nodes: nodes!.results as Contact[], edges: edges!.results as Connection[]};
}
function traverse(nodes: Contact[], edges: Connection[], start: string, hops: number, type: string | null) {
  if (!nodes.some(n => n.id === start)) throw notFound("no such workspace contact");
  const adjacency = new Map<string, Array<{id: string; edge: Connection}>>();
  for (const edge of edges) if (!type || type === edge.type) for (const [a, b] of [[edge.a, edge.b], [edge.b, edge.a]] as const) {const aEdges = adjacency.get(a) ?? []; aEdges.push({id: b, edge}); adjacency.set(a, aEdges);}
  const seen = new Map<string, {depth: number; parent: string | null; edge: Connection | null}>([[start, {depth: 0, parent: null, edge: null}]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!, depth = seen.get(current)!.depth;
    if (depth >= hops) continue;
    for (const next of adjacency.get(current) ?? []) if (!seen.has(next.id)) {seen.set(next.id, {depth: depth + 1, parent: current, edge: next.edge}); queue.push(next.id);}
  }
  return seen;
}
export const graphNeighbors = defineVerb({...base, name: "graph.neighbors", kind: "query", minRole: "reader", summary: "Traverse an undirected workspace contact neighborhood, 1–6 hops (default 1), optionally one connection type. Returns nodes, induced edges and depth. Limits: 2000 entities/10000 edges; oversized graphs are refused.", mcp: {scope: "read", destructive: false, title: "Contact neighborhood", input: schema({id: str, hops: {type: "integer", minimum: 1, maximum: 6}, type: str}, ["project", "id"])}, parse: i => ({...entityRef(i), hops: optInt(i, "hops", {min: 1, max: 6}) ?? 1, type: optString(i, "type", {max: 100})}), run: async (ctx, v) => {
  const g = await graph(ctx, v.project), seen = traverse(g.nodes, g.edges, v.id, v.hops, v.type);
  return {nodes: g.nodes.filter(n => seen.has(n.id)).map(n => ({id: n.id, kind: n.kind, name: n.name, depth: seen.get(n.id)!.depth})), connections: g.edges.filter(e => seen.has(e.a) && seen.has(e.b) && (!v.type || e.type === v.type))};
}});
export const graphPath = defineVerb({...base, name: "graph.path", kind: "query", minRole: "reader", summary: "Find the shortest undirected introduction path between workspace contacts using breadth-first search, optionally one connection type. Returns found=false for disconnected contacts. Limits: 2000 entities/10000 edges; oversized graphs are refused.", mcp: {scope: "read", destructive: false, title: "Introduction path", input: schema({from: str, to: str, type: str}, ["project", "from", "to"])}, parse: i => ({...projectRef(i), from: reqString(i, "from", {max: 100}), to: reqString(i, "to", {max: 100}), type: optString(i, "type", {max: 100})}), run: async (ctx, v) => {
  const g = await graph(ctx, v.project);
  if (!g.nodes.some(n => n.id === v.to)) throw notFound("no such workspace contact");
  const seen = traverse(g.nodes, g.edges, v.from, 2000, v.type);
  const path: string[] = [], connections: Connection[] = [];
  if (seen.has(v.to)) for (let id: string | null = v.to; id !== null;) {path.push(id); const step: {depth: number; parent: string | null; edge: Connection | null} = seen.get(id)!; if (step.edge) connections.push(step.edge); id = step.parent;}
  return {found: seen.has(v.to), nodes: path.reverse().map(id => {const n = g.nodes.find(n => n.id === id)!; return {id: n.id, name: n.name, kind: n.kind};}), connections: connections.reverse(), hops: seen.get(v.to)?.depth ?? null};
}});
export const personMerge = defineVerb({...base, name: "person.merge", kind: "command", minRole: "member", summary: "Merge one workspace person into another. Target scalar fields win, emails/phones/tags are unioned and notes appended. Connections and content backlinks move to target; source is removed. Both current revisions are required. Does not affect Pimwell identities or membership.", mcp: {scope: "write", destructive: false, auditKeysOnly: true, title: "Merge people", input: schema({from: str, into: str, from_revision: {type: "integer", minimum: 1}, into_revision: {type: "integer", minimum: 1}}, ["project", "from", "into", "from_revision", "into_revision"])}, parse: i => {
  const from = reqString(i, "from", {max: 100}), into = reqString(i, "into", {max: 100});
  if (from === into) throw badRequest("merge requires two different people");
  const from_revision = optInt(i, "from_revision", {min: 1, max: 2147483646}), into_revision = optInt(i, "into_revision", {min: 1, max: 2147483646});
  if (from_revision === null || into_revision === null) throw badRequest("both revisions required");
  return {...projectRef(i), from, into, from_revision, into_revision};
}, run: async (ctx, v) => {
  const p = await contactProject(ctx, v.project, true), tid = ctx.tenant!.id;
  const from = await entity(ctx, p.id, v.from, "person"), into = await entity(ctx, p.id, v.into, "person");
  if (from.revision !== v.from_revision || into.revision !== v.into_revision) throw conflict("stale merge: read both people");
  const a = JSON.parse(from.data) as Record<string, unknown>, b = JSON.parse(into.data) as Record<string, unknown>;
  for (const key of ["emails", "phones", "tags"]) b[key] = [...new Set([...(b[key] as string[]), ...(a[key] as string[])])];
  b.notes = [b.notes, a.notes].filter(Boolean).join("\n\n"); b.title = b.title || a.title;
  // All statements share a transaction. A failed revision assertion rolls the entire merge back.
  // NOT NULL violation is an intentional atomic guard against edits between read and batch.
  try {
    await ctx.db.batch([
      ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:193:7:personMerge.run:ae9df419*/ INSERT INTO contact_entity (tenant_id, project_id, id, kind, name, data, updated_at) SELECT ?, ?, ?, 'person', '', NULL, ? WHERE NOT EXISTS (SELECT 1 FROM contact_entity WHERE tenant_id = ? AND project_id = ? AND id = ?)").bind(tid, p.id, v.into, ctx.now, tid, p.id, v.into),
      ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:194:7:personMerge.run:67012128*/ UPDATE contact_entity SET data = CASE WHEN revision = ? AND EXISTS (SELECT 1 FROM contact_entity WHERE tenant_id = ? AND project_id = ? AND id = ? AND revision = ?) THEN ? ELSE NULL END, revision = revision + 1, updated_at = ? WHERE tenant_id = ? AND project_id = ? AND id = ?").bind(v.into_revision, tid, p.id, v.from, v.from_revision, JSON.stringify(b), ctx.now, tid, p.id, v.into),
      ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:195:7:personMerge.run:6971ce61*/ DELETE FROM contact_connection WHERE tenant_id = ? AND project_id = ? AND ((a = ? AND b = ?) OR (a = ? AND b = ?))").bind(tid, p.id, v.from, v.into, v.into, v.from),
      ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:196:7:personMerge.run:96192247*/ UPDATE contact_connection SET a = CASE WHEN a = ? THEN ? ELSE a END, b = CASE WHEN b = ? THEN ? ELSE b END WHERE tenant_id = ? AND project_id = ? AND (a = ? OR b = ?)").bind(v.from, v.into, v.from, v.into, tid, p.id, v.from, v.from),
      ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:197:7:personMerge.run:3c65f325*/ INSERT OR IGNORE INTO contact_link (tenant_id, project_id, entity_id, kind, ref) SELECT tenant_id, project_id, ?, kind, ref FROM contact_link WHERE tenant_id = ? AND project_id = ? AND entity_id = ?").bind(v.into, tid, p.id, v.from),
      ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:198:7:personMerge.run:13fcfc7e*/ DELETE FROM contact_link WHERE tenant_id = ? AND project_id = ? AND entity_id = ?").bind(tid, p.id, v.from),
      ctx.db.prepare("/*perf-site:src%2Fverbs%2Fcontacts.ts:199:7:personMerge.run:dc95264f*/ DELETE FROM contact_entity WHERE tenant_id = ? AND project_id = ? AND id = ?").bind(tid, p.id, v.from),
    ]);
  } catch (e) {if (String(e).includes("NOT NULL")) throw conflict("stale merge: read both people"); throw e;}
  return {entity: unpack(await entity(ctx, p.id, v.into, "person")), merged: v.from, backlinks: await backlinks(ctx, p.id, v.into)};
}});
export const contactVerbs = [personUpsert, personRead, personList, personMerge, companyUpsert, companyRead, companyList, connectionAdd, connectionRemove, connectionList, graphNeighbors, graphPath];
