/** MCP spec 8.6: tool text is Markdown for a model and never longer than this. */
export const MCP_TEXT_LIMIT = 20_000;
const TRAILER_ROOM = 200;
const SCALAR_MAX = 2_000;

type Row = Record<string, unknown>;

function cell(key: string, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && key.endsWith("_at")) return new Date(v).toISOString();
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function isRowList(v: unknown): v is Row[] {
  return Array.isArray(v) && v.every((x) => x !== null && typeof x === "object" && !Array.isArray(x));
}

function columns(rows: Row[]): string[] {
  const keys: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  return keys;
}

/**
 * One line of summary, scalar fields as a list, each list of rows as a table, then `next_cursor`.
 * Over the limit, rows are cut at a row boundary with "truncated; N more", plus the cursor to resume
 * from when the result is paged (its rows' `id` is the cursor, as in `event.list`).
 */
export function renderMarkdown(verb: string, result: unknown, limit: number = MCP_TEXT_LIMIT): string {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return `**${verb}**: ${cell("", result).slice(0, SCALAR_MAX)}`;
  const obj = result as Record<string, unknown>;
  const lists = Object.entries(obj).filter((e): e is [string, Row[]] => isRowList(e[1]));
  const counts = lists.map(([k, rows]) => `${rows.length} ${k}`).join(", ");
  const lines = [`**${verb}**${counts ? `: ${counts}` : ""}`];
  for (const [k, v] of Object.entries(obj)) {
    if (k === "next_cursor" || isRowList(v)) continue;
    lines.push(`- ${k}: ${cell(k, v).slice(0, SCALAR_MAX)}`);
  }
  let used = lines.join("\n").length;
  let cut: { more: number; lastId: string | null } | null = null;
  for (const [k, rows] of lists) {
    if (cut) {
      cut.more += rows.length;
      continue;
    }
    if (rows.length === 0) {
      lines.push("", `### ${k}`, "", "None.");
      used += k.length + 12;
      continue;
    }
    const cols = columns(rows);
    const head = ["", `### ${k}`, "", `| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`];
    lines.push(...head);
    used += head.join("\n").length + 1;
    let lastId: string | null = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const line = `| ${cols.map((c) => cell(c, row[c])).join(" | ")} |`;
      if (used + line.length + 1 > limit - TRAILER_ROOM) {
        cut = { more: rows.length - i, lastId };
        break;
      }
      lines.push(line);
      used += line.length + 1;
      lastId = typeof row.id === "string" ? row.id : null;
    }
  }
  if (cut) {
    const resume = "next_cursor" in obj && cut.lastId ? `, pass cursor=${cut.lastId}` : "";
    lines.push("", `truncated; ${cut.more} more${resume}`);
  } else if (typeof obj.next_cursor === "string") {
    lines.push("", `next_cursor: ${obj.next_cursor}`);
  }
  return lines.join("\n");
}
