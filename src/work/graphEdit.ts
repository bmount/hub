// Reading and changing the work graph in D1 (docs/ops/work-graph.md). Every change that touches dependency edges
// goes through commitGraphEdit: it reads the graph and its revision in one snapshot, checks the change against the
// whole graph, and commits the change, its audit events and revision + 1 in one batch. A concurrent edit from the
// same revision fails the revision's primary key, so its batch rolls back and is recomputed against the new graph.
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
    db.prepare("SELECT COALESCE(MAX(rev), 0) AS rev FROM work_graph_rev WHERE tenant_id = ?").bind(tenant_id),
    db.prepare(`SELECT w.id, w.kind, w.state, w.owner_id, w.lease_until, w.priority, w.estimate, w.created_at, w.title, w.project_id, p.slug || '#' || w.number AS ref, o.email AS owner_email
      FROM work_item w JOIN project p ON p.id = w.project_id LEFT JOIN identity o ON o.id = w.owner_id WHERE w.tenant_id = ?`).bind(tenant_id),
    db.prepare("SELECT prereq_id, dependent_id FROM work_dep WHERE tenant_id = ?").bind(tenant_id),
    db.prepare("SELECT item_id, name, mode FROM work_resource WHERE tenant_id = ?").bind(tenant_id),
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
        db.prepare("INSERT INTO work_graph_rev (tenant_id, rev, created_at) VALUES (?, ?, ?)").bind(tenant_id, g.rev + 1, now),
        ...statements,
        db.prepare("DELETE FROM work_graph_rev WHERE tenant_id = ? AND rev < ?").bind(tenant_id, g.rev + 1),
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
    const known = new Map(g.nodes.map((n) => [n.id, n])), key = (e: Edge) => `${e.prereq_id}>${e.dependent_id}`;
    for (const e of [...change.add, ...change.remove]) {
      if (!known.has(e.prereq_id) || !known.has(e.dependent_id)) throw badRequest("both items must exist in this organization");
      if (e.prereq_id === e.dependent_id) throw badRequest("an item cannot depend on itself");
    }
    const current = new Set(g.edges.map(key)), dropping = new Set(change.remove.map(key));
    const added = change.add.filter((e, i) => !current.has(key(e)) && !dropping.has(key(e)) && change.add.findIndex((x) => key(x) === key(e)) === i);
    const removed = change.remove.filter((e) => current.has(key(e)));
    const next = [...g.edges.filter((e) => !dropping.has(key(e))), ...added];
    const cycle = findCycle(next);
    if (cycle) throw badRequest(`that would make a dependency cycle: ${cycle.map((id) => known.get(id)!.ref).join(" → ")}; nothing was changed`);
    result = { added, removed };
    const ref = (id: string) => known.get(id)!.ref;
    const event = (kind: string, e: Edge, summary: string) => eventStatement(db, { ...actorFields(actor), kind, target_kind: "work_item", target_id: e.dependent_id, summary }, now);
    return [
      ...added.flatMap((e) => [
        db.prepare("INSERT INTO work_dep (tenant_id, prereq_id, dependent_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(actor.tenant_id, e.prereq_id, e.dependent_id, actor.identity_id, now),
        event("work.depend", e, `${ref(e.dependent_id)} now waits on ${ref(e.prereq_id)}`),
      ]),
      ...removed.flatMap((e) => [
        db.prepare("DELETE FROM work_dep WHERE prereq_id = ? AND dependent_id = ?").bind(e.prereq_id, e.dependent_id),
        event("work.undepend", e, `${ref(e.dependent_id)} no longer waits on ${ref(e.prereq_id)}`),
      ]),
      // Stale snapshots of a dependent (an agent about to claim it) must not survive a change to what it waits on.
      ...[...new Set([...added, ...removed].map((e) => e.dependent_id))].map((id) => db.prepare("UPDATE work_item SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?").bind(now, id)),
    ];
  });
  return result;
}

/** Replace the resources an item needs while under way. */
export async function setResources(db: D1Database, actor: Actor, item: WorkItem, ref: string, resources: Array<{ name: string; mode: "exclusive" | "shared" }>, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM work_resource WHERE item_id = ?").bind(item.id),
    ...resources.map((r) => db.prepare("INSERT INTO work_resource (tenant_id, item_id, name, mode) VALUES (?, ?, ?, ?)").bind(actor.tenant_id, item.id, r.name, r.mode)),
    db.prepare("UPDATE work_item SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?").bind(now, item.id),
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
      db.prepare("DELETE FROM work_dep WHERE prereq_id = ? OR dependent_id = ?").bind(item.id, item.id),
      db.prepare("DELETE FROM work_resource WHERE item_id = ?").bind(item.id),
      db.prepare("DELETE FROM work_link WHERE item_id = ?").bind(item.id),
      db.prepare("UPDATE work_comment SET reply_to = NULL WHERE item_id = ?").bind(item.id),
      db.prepare("DELETE FROM work_comment WHERE item_id = ?").bind(item.id),
      db.prepare("DELETE FROM attention WHERE item_id = ?").bind(item.id),
      db.prepare("UPDATE work_item SET parent_id = NULL, updated_at = MAX(updated_at + 1, ?) WHERE parent_id = ?").bind(now, item.id),
      db.prepare("UPDATE model_call SET work_item_id = NULL WHERE work_item_id = ?").bind(item.id),
      db.prepare("UPDATE app_error_group SET work_item_id = NULL WHERE work_item_id = ?").bind(item.id),
      ...released.map((id) => db.prepare("UPDATE work_item SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?").bind(now, id)),
      db.prepare("DELETE FROM work_item WHERE id = ?").bind(item.id),
      eventStatement(db, { ...actorFields(actor), kind: "work.delete", target_kind: "work_item", target_id: item.id, summary: `Deleted ${ref}: ${item.title}` }, now),
    ];
  });
  return { released };
}

const actorFields = (a: Actor) => ({ tenant_id: a.tenant_id, identity_id: a.identity_id, session_id: a.session_id });
