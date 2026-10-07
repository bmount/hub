/** Messaging spec 5.1: typed references and mentions, read outside code spans and code blocks only. */
export type ParsedRef =
  | { kind: "commit"; text: string; repo: string; oid: string }
  | { kind: "ticket"; text: string; repo: string; ticket: string }
  | { kind: "session"; text: string; session_id: string }
  | { kind: "msg"; text: string; channel: string | null; seq: number | null; msg_id: string | null };

export type ParsedBody = { refs: ParsedRef[]; handles: string[]; broadcasts: string[] };

const BROADCAST = new Set(["channel", "here", "all", "everyone"]);
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const NAME = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// A ref starts where no word, address, path, or other ref could be continuing.
const LEAD = "(?<![A-Za-z0-9_@.:/#-])";
const COMMIT = new RegExp(`${LEAD}(?:commit:)?(${NAME})@([0-9a-f]{7,40})(?![0-9A-Za-z_@-]|\\.[A-Za-z0-9])`, "g");
const TICKET = new RegExp(`${LEAD}(?:ticket:)?(${NAME})#([a-z0-9]{4,16})(?![0-9A-Za-z_-])`, "g");
const SESSION = new RegExp(`${LEAD}session:(${ULID})(?![0-9A-Za-z])`, "g");
const MSG = new RegExp(`${LEAD}msg:(?:(${NAME})/(\\d{1,9})|(${ULID}))(?![0-9A-Za-z])`, "g");
// Handles are lowercase; a mention is read case-insensitively and folded (`@Scout` mentions scout).
const MENTION = /(?<![A-Za-z0-9_@./-])@([A-Za-z][A-Za-z0-9-]{1,23})(?![A-Za-z0-9-]|\.[A-Za-z0-9]|@)/g;
// A backtick fence takes no backtick in its info string (CommonMark); "```a`` x" is a code span, not a fence.
const FENCE = /^ {0,3}(`{3,}(?![^\n]*`)|~{3,})/;

/** Code spans (CommonMark): a run of n backticks opens, the next run of exactly n closes. A run with no partner is literal text. */
function blankSpans(text: string, blank: (m: string) => string): string {
  const runs: Array<{ at: number; len: number }> = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`") { i++; continue; }
    let j = i;
    while (text[j] === "`") j++;
    runs.push({ at: i, len: j - i });
    i = j;
  }
  // Runs by length, in order; each opener takes the first later run of its length. Linear overall.
  const byLen = new Map<number, number[]>();
  runs.forEach((r, idx) => {
    const list = byLen.get(r.len);
    if (list) list.push(idx);
    else byLen.set(r.len, [idx]);
  });
  const cursor = new Map<number, number>();
  let out = "";
  let pos = 0;
  for (let idx = 0; idx < runs.length; idx++) {
    const open = runs[idx]!;
    if (open.at < pos) continue;
    const list = byLen.get(open.len)!;
    let k = cursor.get(open.len) ?? 0;
    while (k < list.length && list[k]! <= idx) k++;
    cursor.set(open.len, k);
    const close = k < list.length ? runs[list[k]!]! : null;
    if (!close) continue;
    out += text.slice(pos, open.at) + blank(text.slice(open.at, close.at + close.len));
    pos = close.at + close.len;
  }
  return out + text.slice(pos);
}

/** Code blocks (fenced, and indented by four spaces or a tab) and code spans replaced by spaces (newlines kept), so nothing in them is read as a ref or mention. */
export function stripCode(body: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  let fence: string | null = null;
  // An indented line is code only where a paragraph is not running: at the start, after a blank line, or inside an indented block.
  let prevBlank = true;
  let inIndented = false;
  const lines = body.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    if (fence !== null) {
      prevBlank = true;
      inIndented = false;
    } else {
      const blankLine = line.trim() === "";
      if (!blankLine && /^( {4}|\t)/.test(line) && (prevBlank || inIndented)) {
        inIndented = true;
        prevBlank = false;
        return blank(line);
      }
      if (!blankLine) inIndented = false;
      prevBlank = blankLine ? true : false;
    }
    const m = FENCE.exec(line);
    if (fence === null) {
      if (!m) return line;
      fence = m[1]!;
      return blank(line);
    }
    // A closing fence: same character, at least as long, nothing after it. Unclosed blocks run to the end (CommonMark).
    if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && /^ {0,3}[`~]+[ \t]*$/.test(line)) fence = null;
    return blank(line);
  });
  return blankSpans(lines.join("\n"), blank);
}

export function parseBody(body: string): ParsedBody {
  const text = stripCode(body);
  const found: Array<{ at: number; ref: ParsedRef }> = [];
  for (const m of text.matchAll(COMMIT)) found.push({ at: m.index!, ref: { kind: "commit", text: `${m[1]}@${m[2]}`, repo: m[1]!, oid: m[2]! } });
  for (const m of text.matchAll(TICKET)) found.push({ at: m.index!, ref: { kind: "ticket", text: `${m[1]}#${m[2]}`, repo: m[1]!, ticket: m[2]! } });
  for (const m of text.matchAll(SESSION)) found.push({ at: m.index!, ref: { kind: "session", text: `session:${m[1]}`, session_id: m[1]! } });
  for (const m of text.matchAll(MSG)) {
    found.push({
      at: m.index!,
      ref: m[3]
        ? { kind: "msg", text: `msg:${m[3]}`, channel: null, seq: null, msg_id: m[3] }
        : { kind: "msg", text: `msg:${m[1]}/${m[2]}`, channel: m[1]!, seq: Number(m[2]), msg_id: null },
    });
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const refs: ParsedRef[] = [];
  for (const { ref } of found) {
    const k = `${ref.kind}:${ref.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    refs.push(ref);
  }
  const handles: string[] = [];
  const broadcasts: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const h = m[1]!.toLowerCase();
    const list = BROADCAST.has(h) ? broadcasts : handles;
    if (!list.includes(h)) list.push(h);
  }
  return { refs, handles, broadcasts };
}

const PREFIX: Record<string, string> = { commit: "commit:", ticket: "ticket:", session: "session:", msg: "msg:" };

/** An explicit `{kind, key}` ref (spec 5.1: "Callers may also pass refs"), the key in body syntax without the prefix. */
export function parseRefText(kind: string, key: string): ParsedRef | null {
  const prefix = PREFIX[kind];
  const k = key.trim();
  if (!prefix || !/^\S{1,128}$/.test(k)) return null;
  const refs = parseBody(prefix + k).refs;
  return refs.length === 1 && refs[0]!.kind === kind ? refs[0]! : null;
}
