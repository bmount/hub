// The work graph as people and agents see it: references instead of ids, readiness in words. Shared by the graph
// verbs and the Docket verbs so every surface describes an item's readiness the same way.
import { loadGraph, type Graph, type GraphItem } from "./graphEdit";
import { readiness, type Readiness } from "./graph";
import { cleanText } from "../mcp/render";
import type { Ctx } from "../auth/context";

/** What readiness means for one item, with references instead of ids. */
export type ReadinessView = { status: Readiness["status"]; waiting_on?: string[]; with?: string[]; owner?: string; until?: number; claimed?: boolean };
export type View = { ref: string; title: string; state: string; priority: number; estimate: number | null; readiness: ReadinessView };

/** The tenant's graph with readiness computed now, and helpers to show it with references. */
export async function graphContext(ctx: Ctx) {
  return viewGraph(await loadGraph(ctx.db, ctx.tenant!.id), ctx.now);
}

export function viewGraph(g: Graph, now: number) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const ready = readiness(g.nodes, g.edges, g.resources, now);
  const refOf = (id: string) => byId.get(id)?.ref ?? id;
  const readinessOf = (id: string): ReadinessView => {
    const r = ready.get(id) ?? { status: "closed" as const };
    if (r.status === "blocked") return { status: r.status, waiting_on: r.waiting_on.map(refOf), claimed: r.claimed };
    if (r.status === "conflict") return { status: r.status, with: r.with.map(refOf) };
    if (r.status === "claimed") return { status: r.status, owner: byId.get(id)?.owner_email ?? r.owner_id, until: r.until };
    return { status: r.status };
  };
  const view = (n: GraphItem): View => ({ ref: n.ref, title: n.title, state: n.state, priority: n.priority, estimate: n.estimate, readiness: readinessOf(n.id) });
  return { g, byId, ready, refOf, readinessOf, view };
}

export const describeReadiness = (r: ReadinessView) => r.status === "blocked" ? `blocked: waits on ${r.waiting_on!.join(", ")}${r.claimed ? " (claimed anyway)" : ""}`
  : r.status === "conflict" ? `waiting for a resource held by ${r.with!.join(", ")}`
  : r.status === "claimed" ? `claimed by ${r.owner} until ${new Date(r.until!).toISOString().slice(0, 16)}`
  : r.status;

export const graphLine = (v: View) => `- **${v.ref}** P${v.priority}${v.estimate ? `, ~${v.estimate}h` : ""}, ${v.state}, ${describeReadiness(v.readiness)}: ${cleanText(v.title)}`;
