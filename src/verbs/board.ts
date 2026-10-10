// The board and bulk changes (planned verbs built 2026-10-07). The board groups work by state, shows each quest's
// progress, and flags what has stalled. Bulk update runs work.update once per item, so every change is audited and
// followers hear about it exactly as for a single edit.
import { defineVerb } from "./table";
import { optString } from "./params";
import { badRequest } from "../errors";
import type { Ctx } from "../auth/context";
import { DATA_NOTE, cleanText } from "../mcp/render";
import { workUpdate } from "./work";
import { KINDS, STATES, type WorkKind, type WorkState } from "../work/names";

const STALL_MS = 7 * 86_400_000;
const DONE_WINDOW_MS = 14 * 86_400_000;
export const BOARD_ITEM_LIMIT = 500;
export const CLOSURE_ACTOR_LIMIT = 50;
export const CLOSURE_NOTE = "Distinct retained items with recorded done transitions per actor, including reopened items; one item can appear under multiple actors. Not current ownership, work quality or proof of execution. Historical prose events are not attributed; tracking starts with work.done events. Counts cover this scope, all recorded time, not the two-week done column.";
export type ClosureCounts = {
  actors: Array<{ identity_id: string; name: string; kind: string; items: number }>;
  total_actors: number; limit: number; truncated: boolean;
  currently_done_without_record: number; note: string;
};

export type BoardItem = { ref: string; slug: string; number: number; kind: WorkKind; state: WorkState; title: string; owner: string | null; updated_at: number; stalled: boolean };
export type Quest = { ref: string; slug: string; number: number; title: string; state: WorkState; done: number; total: number };
export type Board = {
  scope: string; columns: Record<"open" | "doing" | "done", BoardItem[]>; quests: Quest[]; stalled: number;
  totals: Record<"open" | "doing" | "done", number>;
  examples: { limit: number; shown: number; truncated: boolean };
  closures: ClosureCounts;
};

export async function board(ctx: Ctx, project: string | null): Promise<Board> {
  // Counts and bounded examples share predicates and one D1 batch. Never infer totals
  // (especially old stalled items) from the globally newest-item sample.
  const scope = "w.tenant_id = ? AND p.tenant_id = w.tenant_id AND p.kind <> 'channel' AND (? IS NULL OR p.slug = ?)";
  const visible = "(w.state IN ('open', 'doing') OR (w.state = 'done' AND w.closed_at > ?))";
  const args = [ctx.tenant!.id, project, project, ctx.now - DONE_WINDOW_MS];
  const [items, quests, counts, closers, closureGaps] = await ctx.db.batch([
    ctx.db.prepare(`SELECT p.slug, w.number, w.kind, w.state, w.title, w.updated_at, i.display_name AS owner FROM work_item w JOIN project p ON p.id = w.project_id LEFT JOIN identity i ON i.id = w.owner_id
      WHERE ${scope} AND ${visible} ORDER BY w.updated_at DESC, w.id DESC LIMIT ?`)
      .bind(...args, BOARD_ITEM_LIMIT),
    // Aggregate children once for the requested scope, not two correlated scans per
    // quest. Materialization is request-local: counts stay fresh, with no cache or
    // invalidation dependency. Keep project in the grouping/join as well as tenant.
    ctx.db.prepare(`WITH child_counts AS MATERIALIZED (
        SELECT c.parent_id, c.project_id, SUM(c.state = 'done') AS done, COUNT(*) AS total
        FROM work_item c JOIN project cp ON cp.id = c.project_id
        WHERE c.tenant_id = ? AND cp.tenant_id = c.tenant_id AND cp.kind <> 'channel'
          AND (? IS NULL OR cp.slug = ?) AND c.parent_id IS NOT NULL AND c.state <> 'dropped'
        GROUP BY c.parent_id, c.project_id
      )
      SELECT p.slug, q.number, q.title, q.state, COALESCE(c.done, 0) AS done, COALESCE(c.total, 0) AS total
      FROM work_item q JOIN project p ON p.id = q.project_id
      LEFT JOIN child_counts c ON c.parent_id = q.id AND c.project_id = q.project_id
      WHERE q.tenant_id = ? AND p.tenant_id = q.tenant_id AND p.kind <> 'channel'
        AND (? IS NULL OR p.slug = ?) AND q.kind = 'quest' AND q.state IN ('open', 'doing') ORDER BY q.number, q.id`)
      .bind(ctx.tenant!.id, project, project, ctx.tenant!.id, project, project),
    ctx.db.prepare(`SELECT COALESCE(SUM(w.state = 'open'), 0) AS open,
        COALESCE(SUM(w.state = 'doing'), 0) AS doing, COALESCE(SUM(w.state = 'done'), 0) AS done,
        COALESCE(SUM(w.state = 'doing' AND w.updated_at < ?), 0) AS stalled
      FROM work_item w JOIN project p ON p.id = w.project_id WHERE ${scope} AND ${visible}`)
      .bind(ctx.now - STALL_MS, ...args),
    ctx.db.prepare(`SELECT e.identity_id, COALESCE(i.display_name, 'Unknown actor') AS name,
        COALESCE(i.kind, 'unknown') AS kind, COUNT(DISTINCT w.id) AS items, COUNT(*) OVER () AS total_actors
      FROM event e JOIN work_item w ON w.id = e.target_id AND w.tenant_id = e.tenant_id
      JOIN project p ON p.id = w.project_id LEFT JOIN identity i ON i.id = e.identity_id
      WHERE ${scope} AND e.kind = 'work.done' AND e.target_kind = 'work_item'
      GROUP BY e.identity_id ORDER BY items DESC, e.identity_id LIMIT ?`)
      .bind(ctx.tenant!.id, project, project, CLOSURE_ACTOR_LIMIT),
    ctx.db.prepare(`SELECT COUNT(*) AS unattributed FROM work_item w JOIN project p ON p.id = w.project_id
      WHERE ${scope} AND w.state = 'done' AND NOT EXISTS (
        SELECT 1 FROM event e WHERE e.tenant_id = w.tenant_id AND e.target_id = w.id
          AND e.target_kind = 'work_item' AND e.kind = 'work.done')`)
      .bind(ctx.tenant!.id, project, project),
  ]);
  const columns: Board["columns"] = { open: [], doing: [], done: [] };
  for (const r of items!.results as Array<Omit<BoardItem, "ref" | "stalled">>) {
    const s = r.state === "doing" && ctx.now - r.updated_at > STALL_MS;
    const col = r.state === "done" ? "done" : r.state === "doing" ? "doing" : "open";
    columns[col].push({ ...r, ref: `${r.slug}#${r.number}`, stalled: s });
  }
  const { open, doing, done, stalled } = counts!.results[0] as Board["totals"] & { stalled: number };
  return {
    scope: project ?? "organization", columns,
    quests: (quests!.results as Array<Omit<Quest, "ref">>).map((q) => ({ ...q, ref: `${q.slug}#${q.number}` })),
    totals: { open, doing, done }, stalled,
    examples: { limit: BOARD_ITEM_LIMIT, shown: items!.results.length, truncated: open + doing + done > items!.results.length },
    closures: {
      actors: (closers!.results as Array<ClosureCounts["actors"][number] & { total_actors: number }>).map(({ total_actors: _, ...actor }) => actor),
      total_actors: (closers!.results[0] as { total_actors: number } | undefined)?.total_actors ?? 0,
      limit: CLOSURE_ACTOR_LIMIT,
      truncated: ((closers!.results[0] as { total_actors: number } | undefined)?.total_actors ?? 0) > closers!.results.length,
      currently_done_without_record: (closureGaps!.results[0] as { unattributed: number }).unattributed,
      note: CLOSURE_NOTE,
    },
  };
}

export const workBoard = defineVerb({
  name: "work.board", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "The board: exact open, under-way, recent-done and stalled totals with bounded latest-item examples; each quest's progress. Done covers the last two weeks; stalled means under way, untouched for a week. Includes distinct-item recorded closure counts per actor with historical attribution gaps.",
  mcp: {
    scope: "read", destructive: false, title: "Board",
    input: { type: "object", properties: { project: { type: "string", description: "Omit for the whole organization" } }, additionalProperties: false },
    render: (r) => {
      const b = r as Board;
      const line = (i: BoardItem) => `- **${i.ref}** ${KINDS[i.kind].name}: ${cleanText(i.title)}${i.owner ? ` (${cleanText(i.owner)})` : ""}${i.stalled ? " [stalled]" : ""}`;
      return [DATA_NOTE, "", `**Board: ${cleanText(b.scope)}** (${b.stalled} stalled)`,
        `Exact recorded totals; examples come from the latest ${b.examples.limit}-item sample (${b.examples.shown} sampled${b.examples.truncated ? "; truncated" : ""}). Missing examples do not mean an empty column.`,
        "", "Quests:", ...b.quests.map((q) => `- **${q.ref}** ${cleanText(q.title)}: ${q.done}/${q.total} done`),
        "", `Under way (${b.totals.doing}; showing ${Math.min(b.columns.doing.length, 40)}):`, ...b.columns.doing.slice(0, 40).map(line),
        "", `Open (${b.totals.open}; showing ${Math.min(b.columns.open.length, 40)}):`, ...b.columns.open.slice(0, 40).map(line),
        "", `Done lately (${b.totals.done}; showing ${Math.min(b.columns.done.length, 20)}):`, ...b.columns.done.slice(0, 20).map(line),
        "", `Recorded closures by actor (showing ${b.closures.actors.length} of ${b.closures.total_actors}${b.closures.truncated ? "; truncated" : ""}):`,
        b.closures.note, `Currently done without a structured closure record: ${b.closures.currently_done_without_record}.`,
        ...b.closures.actors.map((a) => `- ${cleanText(a.name)} (${cleanText(a.kind)}, ${a.identity_id}): ${a.items} distinct items`)].join("\n");
    },
  },
  parse: (i) => ({ project: optString(i, "project", { max: 63 }) }),
  run: async (ctx, p) => board(ctx, p.project),
});

export const workBulkUpdate = defineVerb({
  name: "work.bulk_update", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Change state, owner, kind or quest on up to 100 items at once. Each change is recorded and announced as a single edit would be.",
  mcp: {
    scope: "write", destructive: false, title: "Change many items",
    input: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, maxItems: 100, description: "Items, like site#3" }, state: { type: "string", enum: ["open", "doing", "done", "dropped"] }, owner: { type: "string", description: "me, an email, or none" }, kind: { type: "string" }, parent: { type: "integer", minimum: 0, description: "Quest number; 0 for none" } }, required: ["ids"], additionalProperties: false },
    render: (r) => { const x = r as { changed: string[]; failed: Array<{ id: string; reason: string }> }; return `${DATA_NOTE}\n\nChanged ${x.changed.length}: ${x.changed.join(", ")}${x.failed.length ? `\nNot changed: ${x.failed.map((f) => `${f.id} (${f.reason})`).join(", ")}` : ""}`; },
  },
  parse: (i) => {
    const raw = Array.isArray(i.ids) ? i.ids : typeof i.ids === "string" ? i.ids.split(/[\s,]+/) : [];
    const ids = [...new Set((raw as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 80))];
    if (!ids.length || ids.length > 100) throw badRequest("give 1 to 100 items in ids");
    const change: Record<string, unknown> = {};
    for (const k of ["state", "owner", "kind", "parent"]) if (i[k] !== undefined && i[k] !== "") change[k] = i[k];
    if (!Object.keys(change).length) throw badRequest("say what to change: state, owner, kind or parent");
    return { ids, change };
  },
  run: async (ctx, p) => {
    const changed: string[] = [], failed: Array<{ id: string; reason: string }> = [];
    for (const id of p.ids) {
      try {
        const r = (await workUpdate.run(ctx, { id, ...p.change })) as { ref: string };
        changed.push(r.ref);
      } catch (e) {
        failed.push({ id, reason: e instanceof Error && "detail" in e ? String((e as { detail?: string }).detail ?? e.message) : "error" });
      }
    }
    return { changed, failed };
  },
});

export { STATES };
