// Reading and changing the work graph in D1 (docs/ops/work-graph.md). Every change that touches dependency edges
// goes through commitGraphEdit: it reads the graph and its revision in one snapshot, checks the change against the
// whole graph, and commits the change, its audit events and revision + 1 in one batch. A concurrent edit from the
// same revision fails the revision's primary key, so its batch rolls back and is recomputed against the new graph.
import { projectPathSql } from "../db/projects";
import { badRequest, conflict } from "../errors";
import { eventStatement } from "../db/events";
import { findCycle, type Edge, type GraphNode, type Resource } from "./graph";
import type { WorkItem } from "../db/work";

export type GraphItem = GraphNode & { kind: string; ref: string; title: string; project_id: string; owner_email: string | null };
export type Graph = { rev: number; nodes: GraphItem[]; edges: Edge[]; resources: Resource[] };
export type Actor = { tenant_id: string; identity_id: string; session_id: string | null };

const MAX_ATTEMPTS = 4;

/** The statements that read a tenant's graph, so a caller can put them in the same round trip as its own reads. */
export function graphStatements(db: D1Database, tenant_id: string): D1PreparedStatement[] {
  return [
    db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:20:5:graphStatements:634b3ba2*/ SELECT COALESCE(MAX(rev), 0) AS rev FROM work_graph_rev WHERE tenant_id = ?").bind(tenant_id),
    db.prepare(`/*perf-site:src%2Fwork%2FgraphEdit.ts:21:5:graphStatements:00c09dfd*/ SELECT w.id, w.kind, w.state, w.owner_id, w.lease_until, w.priority, w.estimate, w.created_at, w.title, w.project_id, (${projectPathSql()}) || '#' || w.number AS ref, o.email AS owner_email
      FROM work_item w JOIN project p ON p.id = w.project_id LEFT JOIN identity o ON o.id = w.owner_id WHERE w.tenant_id = ?`).bind(tenant_id),
    db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:23:5:graphStatements:38b32f1f*/ SELECT prereq_id, dependent_id FROM work_dep WHERE tenant_id = ?").bind(tenant_id),
    db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:24:5:graphStatements:25164ddf*/ SELECT item_id, name, mode FROM work_resource WHERE tenant_id = ?").bind(tenant_id),
  ];
}

/** One item's incident edges and resource holders, not the unrelated tenant graph.
 * Keep cross-project neighbors for organization reads; MCP's project guard still refuses crossing graphs.
 */
export function itemGraphStatements(db: D1Database, tenant_id: string, item_id: string, now: number): D1PreparedStatement[] {
  const related = `WITH related(id) AS (
    SELECT ? UNION SELECT prereq_id FROM work_dep WHERE tenant_id = ? AND dependent_id = ?
    UNION SELECT dependent_id FROM work_dep WHERE tenant_id = ? AND prereq_id = ?
    UNION SELECT r.item_id FROM work_resource r JOIN work_item h ON h.id = r.item_id
      WHERE r.tenant_id = ? AND r.name IN (SELECT name FROM work_resource WHERE tenant_id = ? AND item_id = ?)
      AND h.tenant_id = ? AND h.state = 'doing' AND h.owner_id IS NOT NULL AND h.lease_until >= ?
  )`;
  return [
    db.prepare("SELECT 0 AS rev"),
    db.prepare(`${related} SELECT w.id, w.kind, w.state, w.owner_id, w.lease_until, w.priority, w.estimate, w.created_at, w.title, w.project_id,
      (${projectPathSql()}) || '#' || w.number AS ref, o.email AS owner_email
      FROM related JOIN work_item w ON w.id = related.id JOIN project p ON p.id = w.project_id LEFT JOIN identity o ON o.id = w.owner_id
      WHERE w.tenant_id = ?`).bind(item_id, tenant_id, item_id, tenant_id, item_id, tenant_id, tenant_id, item_id, tenant_id, now, tenant_id),
    db.prepare("SELECT prereq_id, dependent_id FROM work_dep WHERE tenant_id = ? AND (prereq_id = ? OR dependent_id = ?)").bind(tenant_id, item_id, item_id),
    db.prepare(`SELECT item_id, name, mode FROM work_resource WHERE tenant_id = ? AND
      (item_id = ? OR (name IN (SELECT name FROM work_resource WHERE tenant_id = ? AND item_id = ?)
      AND item_id IN (SELECT id FROM work_item WHERE tenant_id = ? AND state = 'doing' AND owner_id IS NOT NULL AND lease_until >= ?)))`)
      .bind(tenant_id, item_id, tenant_id, item_id, tenant_id, now),
  ];
}

export function graphFrom(results: D1Result[]): Graph {
  const [rev, nodes, edges, resources] = results;
  return { rev: (rev!.results[0] as { rev: number }).rev, nodes: nodes!.results as GraphItem[], edges: edges!.results as Edge[], resources: resources!.results as Resource[] };
}

export async function loadGraph(db: D1Database, tenant_id: string): Promise<Graph> {
  return graphFrom(await db.batch(graphStatements(db, tenant_id)));
}

/** Commit `build`'s statements against a consistent graph, all or nothing. `build` may throw to refuse the edit. */
export async function commitGraphEdit(db: D1Database, tenant_id: string, now: number, build: (g: Graph) => D1PreparedStatement[]): Promise<Graph> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const g = await loadGraph(db, tenant_id);
    const statements = build(g);
    try {
      await db.batch([
        db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:44:9:commitGraphEdit:58031856*/ INSERT INTO work_graph_rev (tenant_id, rev, created_at) VALUES (?, ?, ?)").bind(tenant_id, g.rev + 1, now),
        ...statements,
        db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:46:9:commitGraphEdit:6ccf825e*/ DELETE FROM work_graph_rev WHERE tenant_id = ? AND rev < ?").bind(tenant_id, g.rev + 1),
      ]);
      return g;
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      if (message.includes("work_graph_rev")) continue;
      if (message.includes("FOREIGN KEY")) throw badRequest("that change refers to an item that no longer exists; nothing was changed");
      throw e;
    }
  }
  throw conflict("the work graph kept changing while this edit was computed; nothing was changed, try again");
}

export type DepChange = { add: Edge[]; remove: Edge[] };

/** Add and remove hard dependencies in one transaction. Refuses (changing nothing) if the result would have a cycle. */
export async function changeDeps(db: D1Database, actor: Actor, change: DepChange, now: number): Promise<{ added: Edge[]; removed: Edge[] }> {
  let result = { added: [] as Edge[], removed: [] as Edge[] };
  await commitGraphEdit(db, actor.tenant_id, now, (g) => {
    const planned = depStatements(db, actor, g, change, new Map(), now);
    result = { added: planned.added, removed: planned.removed };
    return planned.statements;
  });
  return result;
}

/**
 * Validate a dependency change against graph `g` (plus items about to be created in the same batch, by id → ref)
 * and return the statements that apply it. Throws, changing nothing, on unknown items, self-dependencies or cycles.
 */
export function depStatements(db: D1Database, actor: Actor, g: Graph, change: DepChange, creating: Map<string, string>, now: number): { statements: D1PreparedStatement[]; added: Edge[]; removed: Edge[] } {
  const known = new Map(g.nodes.map((n) => [n.id, n.ref]));
  for (const [id, r] of creating) known.set(id, r);
  const key = (e: Edge) => `${e.prereq_id}>${e.dependent_id}`;
  for (const e of [...change.add, ...change.remove]) {
    if (!known.has(e.prereq_id) || !known.has(e.dependent_id)) throw badRequest("that change refers to an item that does not exist in this organization; nothing was changed");
    if (e.prereq_id === e.dependent_id) throw badRequest("an item cannot depend on itself");
  }
  const current = new Set(g.edges.map(key)), dropping = new Set(change.remove.map(key));
  const added = change.add.filter((e, i) => !current.has(key(e)) && !dropping.has(key(e)) && change.add.findIndex((x) => key(x) === key(e)) === i);
  const removed = change.remove.filter((e) => current.has(key(e)));
  const cycle = findCycle([...g.edges.filter((e) => !dropping.has(key(e))), ...added]);
  if (cycle) throw badRequest(`that would make a dependency cycle: ${cycle.map((id) => known.get(id)!).join(" → ")}; nothing was changed`);
  const ref = (id: string) => known.get(id)!;
  const event = (kind: string, e: Edge, summary: string) => eventStatement(db, { ...actorFields(actor), kind, target_kind: "work_item", target_id: e.dependent_id, summary }, now);
  return { added, removed, statements: [
    ...added.flatMap((e) => [
      db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:93:7:depStatements:f29d26f6*/ INSERT INTO work_dep (tenant_id, prereq_id, dependent_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(actor.tenant_id, e.prereq_id, e.dependent_id, actor.identity_id, now),
      event("work.depend", e, `${ref(e.dependent_id)} now waits on ${ref(e.prereq_id)}`),
    ]),
    ...removed.flatMap((e) => [
      db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:97:7:depStatements:214fa12b*/ DELETE FROM work_dep WHERE prereq_id = ? AND dependent_id = ?").bind(e.prereq_id, e.dependent_id),
      event("work.undepend", e, `${ref(e.dependent_id)} no longer waits on ${ref(e.prereq_id)}`),
    ]),
    // Stale snapshots of a dependent (an agent about to claim it) must not survive a change to what it waits on.
    ...[...new Set([...added, ...removed].map((e) => e.dependent_id))].map((id) => db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:101:84:depStatements:e4d6b932*/ UPDATE work_item SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?").bind(now, id)),
  ] };
}

/** Replace the resources an item needs while under way. */
export async function setResources(db: D1Database, actor: Actor, item: WorkItem, ref: string, resources: Array<{ name: string; mode: "exclusive" | "shared" }>, now: number): Promise<void> {
  await db.batch([
    db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:108:5:setResources:3602471c*/ DELETE FROM work_resource WHERE item_id = ?").bind(item.id),
    ...resources.map((r) => db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:109:29:setResources:c41fbced*/ INSERT INTO work_resource (tenant_id, item_id, name, mode) VALUES (?, ?, ?, ?)").bind(actor.tenant_id, item.id, r.name, r.mode)),
    db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:110:5:setResources:e4d6b932*/ UPDATE work_item SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?").bind(now, item.id),
    eventStatement(db, { ...actorFields(actor), kind: "work.resources", target_kind: "work_item", target_id: item.id,
      summary: `${ref} needs ${resources.length ? resources.map((r) => `${r.name} (${r.mode})`).join(", ") : "no resources"}` }, now),
  ]);
}

/**
 * Delete an item for good: its edges, resources, links, comments and attention go with it, items under it lose
 * their parent, and usage or error rows that pointed at it keep their data without the pointer. The audit event
 * keeps the reference and title. Dependents that waited on it stop waiting.
 */
export async function deleteWork(db: D1Database, actor: Actor, item: WorkItem, ref: string, now: number): Promise<{ released: string[] }> {
  let released: string[] = [];
  await commitGraphEdit(db, actor.tenant_id, now, (g) => {
    if (!g.nodes.some((n) => n.id === item.id)) throw badRequest("no such item");
    released = g.edges.filter((e) => e.prereq_id === item.id).map((e) => e.dependent_id);
    return [
      db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:127:7:deleteWork:7fafbe1d*/ DELETE FROM work_dep WHERE prereq_id = ? OR dependent_id = ?").bind(item.id, item.id),
      db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:128:7:deleteWork:3602471c*/ DELETE FROM work_resource WHERE item_id = ?").bind(item.id),
      db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:129:7:deleteWork:56f0b098*/ DELETE FROM work_link WHERE item_id = ?").bind(item.id),
      db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:130:7:deleteWork:1360dd23*/ UPDATE work_comment SET reply_to = NULL WHERE item_id = ?").bind(item.id),
      db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:131:7:deleteWork:037e5ad9*/ DELETE FROM work_comment WHERE item_id = ?").bind(item.id),
      db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:132:7:deleteWork:662f0570*/ DELETE FROM attention WHERE item_id = ?").bind(item.id),
      db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:133:7:deleteWork:21aa8f23*/ UPDATE work_proposal SET item_id = NULL WHERE item_id = ?").bind(item.id),
      db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:134:7:deleteWork:b79d2c9d*/ UPDATE work_item SET parent_id = NULL, updated_at = MAX(updated_at + 1, ?) WHERE parent_id = ?").bind(now, item.id),
      db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:135:7:deleteWork:b04e6029*/ UPDATE model_call SET work_item_id = NULL WHERE work_item_id = ?").bind(item.id),
      db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:136:7:deleteWork:7c32836d*/ UPDATE app_error_group SET work_item_id = NULL WHERE work_item_id = ?").bind(item.id),
      ...released.map((id) => db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:137:31:deleteWork:e4d6b932*/ UPDATE work_item SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?").bind(now, id)),
      db.prepare("/*perf-site:src%2Fwork%2FgraphEdit.ts:138:7:deleteWork:adbbb753*/ DELETE FROM work_item WHERE id = ?").bind(item.id),
      eventStatement(db, { ...actorFields(actor), kind: "work.delete", target_kind: "work_item", target_id: item.id, summary: `Deleted ${ref}: ${item.title}` }, now),
    ];
  });
  return { released };
}

const actorFields = (a: Actor) => ({ tenant_id: a.tenant_id, identity_id: a.identity_id, session_id: a.session_id });
