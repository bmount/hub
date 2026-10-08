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

export type BoardItem = { ref: string; slug: string; number: number; kind: WorkKind; state: WorkState; title: string; owner: string | null; updated_at: number; stalled: boolean };
export type Quest = { ref: string; slug: string; number: number; title: string; state: WorkState; done: number; total: number };
export type Board = { scope: string; columns: Record<"open" | "doing" | "done", BoardItem[]>; quests: Quest[]; stalled: number };

export async function board(ctx: Ctx, project: string | null): Promise<Board> {
  const [items, quests] = await ctx.db.batch([
    ctx.db.prepare(`SELECT p.slug, w.number, w.kind, w.state, w.title, w.updated_at, i.display_name AS owner FROM work_item w JOIN project p ON p.id = w.project_id LEFT JOIN identity i ON i.id = w.owner_id
      WHERE w.tenant_id = ? AND (? IS NULL OR p.slug = ?) AND (w.state IN ('open', 'doing') OR (w.state = 'done' AND w.closed_at > ?)) ORDER BY w.updated_at DESC LIMIT 500`)
      .bind(ctx.tenant!.id, project, project, ctx.now - DONE_WINDOW_MS),
    ctx.db.prepare(`SELECT p.slug, q.number, q.title, q.state,
        (SELECT COUNT(*) FROM work_item c WHERE c.parent_id = q.id AND c.state = 'done') AS done,
        (SELECT COUNT(*) FROM work_item c WHERE c.parent_id = q.id AND c.state <> 'dropped') AS total
      FROM work_item q JOIN project p ON p.id = q.project_id WHERE q.tenant_id = ? AND (? IS NULL OR p.slug = ?) AND q.kind = 'quest' AND q.state IN ('open', 'doing') ORDER BY q.number`)
      .bind(ctx.tenant!.id, project, project),
  ]);
  const columns: Board["columns"] = { open: [], doing: [], done: [] };
  let stalled = 0;
  for (const r of items!.results as Array<Omit<BoardItem, "ref" | "stalled">>) {
    const s = r.state === "doing" && ctx.now - r.updated_at > STALL_MS;
    if (s) stalled++;
    const col = r.state === "done" ? "done" : r.state === "doing" ? "doing" : "open";
    columns[col].push({ ...r, ref: `${r.slug}#${r.number}`, stalled: s });
  }
  return { scope: project ?? "organization", columns, quests: (quests!.results as Array<Omit<Quest, "ref">>).map((q) => ({ ...q, ref: `${q.slug}#${q.number}` })), stalled };
}

export const workBoard = defineVerb({
  name: "work.board", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "The board: open, under way, and done in the last two weeks; each quest's progress; and what has stalled (under way, untouched for a week).",
  mcp: {
    scope: "read", destructive: false, title: "Board",
    input: { type: "object", properties: { project: { type: "string", description: "Omit for the whole organization" } }, additionalProperties: false },
    render: (r) => {
      const b = r as Board;
      const line = (i: BoardItem) => `- **${i.ref}** ${KINDS[i.kind].name}: ${cleanText(i.title)}${i.owner ? ` (${cleanText(i.owner)})` : ""}${i.stalled ? " [stalled]" : ""}`;
      return [DATA_NOTE, "", `**Board: ${b.scope}** (${b.stalled} stalled)`, "", "Quests:", ...b.quests.map((q) => `- **${q.ref}** ${cleanText(q.title)}: ${q.done}/${q.total} done`),
        "", `Under way (${b.columns.doing.length}):`, ...b.columns.doing.slice(0, 40).map(line), "", `Open (${b.columns.open.length}):`, ...b.columns.open.slice(0, 40).map(line), "", `Done lately (${b.columns.done.length}):`, ...b.columns.done.slice(0, 20).map(line)].join("\n");
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
