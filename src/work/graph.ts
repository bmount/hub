// The work graph's pure parts (docs/ops/work-graph.md): closures, cycle checks, topological order, critical paths,
// readiness and ranking. Edges point from prerequisite to dependent. Only hard dependencies are edges here; parents
// and links never block. Everything is deterministic, so every surface computes the same answer from the same rows.
import type { WorkState } from "./names";

export type Edge = { prereq_id: string; dependent_id: string };
export type GraphNode = {
  id: string; state: WorkState; owner_id: string | null; lease_until: number | null;
  priority: number; estimate: number | null; created_at: number;
};
export type Resource = { item_id: string; name: string; mode: "exclusive" | "shared" };

export type Readiness =
  | { status: "closed" }
  | { status: "blocked"; waiting_on: string[]; claimed: boolean }
  | { status: "claimed"; owner_id: string; until: number }
  | { status: "conflict"; with: string[] }
  | { status: "ready" };

function adjacency(edges: Edge[], direction: "down" | "up"): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const [from, to] = direction === "down" ? [e.prereq_id, e.dependent_id] : [e.dependent_id, e.prereq_id];
    const list = out.get(from);
    if (list) list.push(to); else out.set(from, [to]);
  }
  for (const list of out.values()) list.sort();
  return out;
}

/** Everything reachable from `start`, nearest first: its prerequisites (up) or what waits on it (down). */
export function closure(edges: Edge[], start: string, direction: "down" | "up"): string[] {
  const next = adjacency(edges, direction), seen = new Set([start]), order: string[] = [];
  for (let queue = [start]; queue.length;) {
    const at = queue.shift()!;
    for (const n of next.get(at) ?? []) if (!seen.has(n)) { seen.add(n); order.push(n); queue.push(n); }
  }
  return order;
}

/** A cycle in the edges as a list of ids (first repeated at the end), or null when there is none. */
export function findCycle(edges: Edge[]): string[] | null {
  const next = adjacency(edges, "down"), state = new Map<string, 1 | 2>(), stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1); stack.push(id);
    for (const n of next.get(id) ?? []) {
      if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
      if (!state.has(n)) { const found = visit(n); if (found) return found; }
    }
    state.set(id, 2); stack.pop();
    return null;
  };
  for (const id of [...new Set(edges.map((e) => e.prereq_id))].sort()) if (!state.has(id)) { const found = visit(id); if (found) return found; }
  return null;
}

const byUrgency = (a: GraphNode, b: GraphNode) => a.priority - b.priority || a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Prerequisites before dependents; among items free at the same time, more urgent and older first. */
export function topoOrder(nodes: GraphNode[], edges: Edge[]): string[] {
  const ids = new Map(nodes.map((n) => [n.id, n]));
  const inside = edges.filter((e) => ids.has(e.prereq_id) && ids.has(e.dependent_id));
  const waiting = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of inside) waiting.set(e.dependent_id, waiting.get(e.dependent_id)! + 1);
  const next = adjacency(inside, "down"), order: string[] = [];
  const free = nodes.filter((n) => waiting.get(n.id) === 0).sort(byUrgency);
  while (free.length) {
    const n = free.shift()!;
    order.push(n.id);
    for (const d of next.get(n.id) ?? []) {
      waiting.set(d, waiting.get(d)! - 1);
      if (waiting.get(d) === 0) { free.push(ids.get(d)!); free.sort(byUrgency); }
    }
  }
  if (order.length !== nodes.length) throw new Error("the work graph has a cycle");
  return order;
}

const open = (n: GraphNode | undefined) => !!n && n.state !== "done" && n.state !== "dropped";

/** For each item, the hours of open work on the longest chain from it to the end (itself included; unknown = 1). */
export function criticalPath(nodes: GraphNode[], edges: Edge[]): Map<string, number> {
  const ids = new Map(nodes.map((n) => [n.id, n])), next = adjacency(edges, "down"), memo = new Map<string, number>();
  const length = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const n = ids.get(id);
    const own = open(n) ? n!.estimate ?? 1 : 0;
    const longest = Math.max(0, ...(next.get(id) ?? []).filter((d) => ids.has(d)).map(length));
    memo.set(id, own + longest);
    return own + longest;
  };
  for (const n of nodes) length(n.id);
  return memo;
}

const live = (n: GraphNode, now: number) => n.state === "doing" && !!n.owner_id && n.lease_until !== null && n.lease_until >= now;

/**
 * Whether each item can be claimed now. Lifecycle state is what people set; readiness is computed from it:
 * a prerequisite counts only when done (dropped does not satisfy it), a live claim holds the item, and an
 * exclusive resource held by another live claim keeps the item waiting.
 */
export function readiness(nodes: GraphNode[], edges: Edge[], resources: Resource[], now: number): Map<string, Readiness> {
  const ids = new Map(nodes.map((n) => [n.id, n])), prereqs = adjacency(edges, "up");
  const held = new Map<string, Resource[]>();
  for (const r of resources) {
    const n = ids.get(r.item_id);
    if (n && live(n, now)) { const list = held.get(r.name); if (list) list.push(r); else held.set(r.name, [r]); }
  }
  const needs = new Map<string, Resource[]>();
  for (const r of resources) { const list = needs.get(r.item_id); if (list) list.push(r); else needs.set(r.item_id, [r]); }
  const out = new Map<string, Readiness>();
  for (const n of nodes) {
    if (!open(n)) { out.set(n.id, { status: "closed" }); continue; }
    const waiting = (prereqs.get(n.id) ?? []).filter((p) => ids.get(p)?.state !== "done");
    if (waiting.length) { out.set(n.id, { status: "blocked", waiting_on: waiting, claimed: live(n, now) }); continue; }
    if (live(n, now)) { out.set(n.id, { status: "claimed", owner_id: n.owner_id!, until: n.lease_until! }); continue; }
    const conflicts = new Set<string>();
    for (const mine of needs.get(n.id) ?? []) {
      for (const other of held.get(mine.name) ?? []) if (other.item_id !== n.id && (mine.mode === "exclusive" || other.mode === "exclusive")) conflicts.add(other.item_id);
    }
    out.set(n.id, conflicts.size ? { status: "conflict", with: [...conflicts].sort() } : { status: "ready" });
  }
  return out;
}

export type Ranked = { id: string; priority: number; critical: number; downstream: number; estimate: number | null };

/** Ready items, best first: priority, then longest open chain behind them, then how much waits on them, then shortest. */
export function rankReady(nodes: GraphNode[], edges: Edge[], ready: Map<string, Readiness>): Ranked[] {
  const ids = new Map(nodes.map((n) => [n.id, n])), critical = criticalPath(nodes, edges);
  return nodes.filter((n) => ready.get(n.id)?.status === "ready").map((n) => ({
    id: n.id, priority: n.priority, critical: critical.get(n.id) ?? 0, estimate: n.estimate,
    downstream: closure(edges, n.id, "down").filter((d) => open(ids.get(d))).length,
  })).sort((a, b) => a.priority - b.priority || b.critical - a.critical || b.downstream - a.downstream
    || (a.estimate ?? Infinity) - (b.estimate ?? Infinity) || byUrgency(ids.get(a.id)!, ids.get(b.id)!));
}
