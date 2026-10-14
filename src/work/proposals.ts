// Proposed changes to the work graph (docs/ops/work-graph.md). An agent that discovers new work or a missing
// prerequisite files a proposal; the live graph does not change until another member approves it. Approval
// rechecks everything against the graph as it is then and applies the new items, the dependency changes and the
// decision in one batch (commitGraphEdit), so it lands completely or not at all.
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { ulid } from "../ids";
import { eventStatement } from "../db/events";
import { commitGraphEdit, depStatements, loadGraph, type Actor, type Graph } from "./graphEdit";
import type { Edge } from "./graph";
import type { WorkKind } from "./names";

/** An end of a proposed dependency: an existing item, or one the proposal creates (by its key). */
export type Endpoint = { id: string } | { new: string };
export type NewItem = { key: string; project_id: string; kind: WorkKind; title: string; body: string; priority: number; estimate: number | null };
export type ProposalChange = {
  new_items: NewItem[];
  add: Array<{ prerequisite: Endpoint; dependent: Endpoint }>;
  remove: Array<{ prerequisite: { id: string }; dependent: { id: string } }>;
};
export type Proposal = {
  id: string; tenant_id: string; item_id: string | null; reason: string; change_json: string; created_by: string; created_at: number;
  decision: "approved" | "rejected" | null; note: string | null; result_json: string | null; decided_by: string | null; decided_at: number | null;
};

const MAX_NEW = 10, MAX_EDGES = 30;

/** Check a change's shape and that it applies cleanly to the graph as it is now (a dry run). */
export function checkChange(db: D1Database, actor: Actor, g: Graph, change: ProposalChange, slugs: Map<string, string>, now: number): void {
  if (!change.new_items.length && !change.add.length && !change.remove.length) throw badRequest("a proposal needs new items, dependencies to add, or dependencies to remove");
  if (change.new_items.length > MAX_NEW || change.add.length + change.remove.length > MAX_EDGES) throw badRequest(`at most ${MAX_NEW} new items and ${MAX_EDGES} dependency changes per proposal`);
  const keys = new Set<string>();
  for (const n of change.new_items) {
    if (keys.has(n.key)) throw badRequest(`new item key ${n.key} is used twice`);
    keys.add(n.key);
  }
  for (const e of change.add) for (const end of [e.prerequisite, e.dependent]) if ("new" in end && !keys.has(end.new)) throw badRequest(`new:${end.new} is not one of the proposal's new items`);
  plan(db, actor, g, change, slugs, now);
}

/** The statements that apply a change, with fresh ids for the new items. Throws, changing nothing, if it no longer fits. */
function plan(db: D1Database, actor: Actor, g: Graph, change: ProposalChange, slugs: Map<string, string>, now: number) {
  const created = new Map(change.new_items.map((n) => [n.key, ulid(now)]));
  const creating = new Map(change.new_items.map((n) => [created.get(n.key)!, `${slugs.get(n.project_id) ?? "?"}#new:${n.key}`]));
  const id = (end: Endpoint) => ("new" in end ? created.get(end.new)! : end.id);
  const edges = (list: Array<{ prerequisite: Endpoint; dependent: Endpoint }>): Edge[] => list.map((e) => ({ prereq_id: id(e.prerequisite), dependent_id: id(e.dependent) }));
  const deps = depStatements(db, actor, g, { add: edges(change.add), remove: edges(change.remove) }, creating, now);
  return { created, deps };
}

export async function getProposal(db: D1Database, tenant_id: string, id: string): Promise<Proposal> {
  const p = await db.prepare(`/*perf-site:src%2Fwork%2Fproposals.ts:51:19:p*/ SELECT p.*, d.decision, d.note, d.result_json, d.decided_by, d.decided_at FROM work_proposal p
    LEFT JOIN work_proposal_decision d ON d.proposal_id = p.id WHERE p.id = ? AND p.tenant_id = ?`).bind(id, tenant_id).first<Proposal>();
  if (!p) throw notFound("no such proposal");
  return p;
}

export async function fileProposal(db: D1Database, actor: Actor, input: { item_id: string | null; reason: string; change: ProposalChange; summary: string }, slugs: Map<string, string>, now: number): Promise<string> {
  checkChange(db, actor, await loadGraph(db, actor.tenant_id), input.change, slugs, now);
  const id = ulid(now);
  await db.batch([
    db.prepare("/*perf-site:src%2Fwork%2Fproposals.ts:61:5:fileProposal*/ INSERT INTO work_proposal (id, tenant_id, item_id, reason, change_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, actor.tenant_id, input.item_id, input.reason, JSON.stringify(input.change), actor.identity_id, now),
    eventStatement(db, { tenant_id: actor.tenant_id, identity_id: actor.identity_id, session_id: actor.session_id, kind: "work.propose", target_kind: "work_proposal", target_id: id, summary: input.summary }, now),
  ]);
  return id;
}

/**
 * Approve or reject. The reviewer must not be the proposer. Approval creates the new items (filed by the approver,
 * who decided the work should exist; the proposer and reason are kept as their source) and applies the dependency
 * changes, all in one batch with the decision. A second decision on the same proposal fails and changes nothing.
 */
export async function decideProposal(db: D1Database, actor: Actor, p: Proposal, decision: "approved" | "rejected", note: string | null, slugs: Map<string, string>, proposer: string, now: number): Promise<{ created: Array<{ key: string; id: string }> }> {
  if (p.decision) throw conflict(`that proposal was already ${p.decision}`);
  if (p.created_by === actor.identity_id) throw forbidden("someone other than the proposer decides a proposal");
  const decide = (result: unknown) => db.prepare("/*perf-site:src%2Fwork%2Fproposals.ts:76:39:decide*/ INSERT INTO work_proposal_decision (proposal_id, decision, note, result_json, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(p.id, decision, note, result === null ? null : JSON.stringify(result), actor.identity_id, now);
  const event = (kind: string, summary: string) => eventStatement(db, { tenant_id: actor.tenant_id, identity_id: actor.identity_id, session_id: actor.session_id, kind, target_kind: "work_proposal", target_id: p.id, summary }, now);
  try {
    if (decision === "rejected") {
      await db.batch([decide(null), event("work.reject", `Rejected proposal ${p.id}${note ? `: ${note}` : ""}`)]);
      return { created: [] };
    }
    let created: Array<{ key: string; id: string }> = [];
    await commitGraphEdit(db, actor.tenant_id, now, (g) => {
      const change = JSON.parse(p.change_json) as ProposalChange;
      const planned = plan(db, actor, g, change, slugs, now);
      created = change.new_items.map((n) => ({ key: n.key, id: planned.created.get(n.key)! }));
      const source = `Proposed by ${proposer}: ${p.reason}`.slice(0, 2000);
      return [
        decide({ items: created }),
        ...change.new_items.map((n) => db.prepare(
          `/*perf-site:src%2Fwork%2Fproposals.ts:92:40:decideProposal*/ INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, priority, estimate, source_kind, source_ref, source_quote, created_by, created_at, updated_at)
           SELECT ?, ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, 'open', ?, ?, 'words', ?, ?, ?, ?, ? FROM work_item WHERE project_id = ?`,
        ).bind(planned.created.get(n.key)!, actor.tenant_id, n.project_id, n.kind, n.title, n.body, n.priority, n.estimate, `proposal:${p.id}`, source, actor.identity_id, now, now, n.project_id)),
        ...change.new_items.map((n) => eventStatement(db, { tenant_id: actor.tenant_id, identity_id: actor.identity_id, session_id: actor.session_id, kind: "work.create",
          target_kind: "work_item", target_id: planned.created.get(n.key)!, summary: `Filed from proposal ${p.id}: ${n.title}`.slice(0, 300) }, now)),
        ...planned.deps.statements,
        event("work.approve", `Approved proposal ${p.id}: ${created.length} new items, ${planned.deps.added.length} dependencies added, ${planned.deps.removed.length} removed`),
      ];
    });
    return { created };
  } catch (e) {
    if (String((e as Error)?.message ?? e).includes("work_proposal_decision")) throw conflict("that proposal was decided by someone else just now");
    throw e;
  }
}
