// Line diffs for code views. Ardi has no diff verb yet, so the hub diffs two versions of a file itself: Myers'
// O((N+M)D) algorithm, unified hunks with three lines of context, capped so a huge file can't stall a page.

export type DiffLine = { op: " " | "+" | "-"; text: string; a: number | null; b: number | null };
export type Hunk = { aStart: number; aLines: number; bStart: number; bLines: number; lines: DiffLine[] };
export type FileDiff = { hunks: Hunk[]; added: number; removed: number; truncated: boolean; binary: boolean };

const MAX_LINES = 8000;
const MAX_D = 4000;
const CONTEXT = 3;

export function decode(b64: string | null): { text: string | null; binary: boolean } {
  if (b64 === null) return { text: "", binary: false };
  const raw = atob(b64);
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  if (bytes.subarray(0, 8000).includes(0)) return { text: null, binary: true };
  return { text: new TextDecoder().decode(bytes), binary: false };
}

const split = (s: string) => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** The edit script from a to b as a list of kept, removed and added lines. Null when it would take too long. */
function script(a: string[], b: string[]): DiffLine[] | null {
  const n = a.length, m = b.length, max = Math.min(n + m, MAX_D);
  const v = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  if (!found) return null;
  const out: DiffLine[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1));
    const pk = down ? k + 1 : k - 1;
    const px = vd.get(pk) ?? 0, py = px - pk;
    while (x > px && y > py) { out.push({ op: " ", text: a[x - 1]!, a: x, b: y }); x--; y--; }
    if (d > 0) {
      if (down) { out.push({ op: "+", text: b[y - 1]!, a: null, b: y }); y--; }
      else { out.push({ op: "-", text: a[x - 1]!, a: x, b: null }); x--; }
    }
  }
  return out.reverse();
}

export function diffText(before: string, after: string): FileDiff {
  let a = split(before), b = split(after);
  const truncated = a.length > MAX_LINES || b.length > MAX_LINES;
  if (truncated) { a = a.slice(0, MAX_LINES); b = b.slice(0, MAX_LINES); }
  const s = script(a, b);
  if (!s) return { hunks: [], added: b.length, removed: a.length, truncated: true, binary: false };
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && s[i]!.op === " ") i++;
    if (i >= s.length) break;
    let start = Math.max(0, i - CONTEXT), end = i;
    // Extend while the next change is within two contexts.
    for (;;) {
      while (end < s.length && s[end]!.op !== " ") end++;
      let gap = end;
      while (gap < s.length && s[gap]!.op === " " && gap - end < CONTEXT * 2) gap++;
      if (gap < s.length && s[gap]!.op !== " ") { end = gap; continue; }
      end = Math.min(s.length, end + CONTEXT);
      break;
    }
    const lines = s.slice(start, end);
    const firstA = lines.find((l) => l.a !== null)?.a ?? (s.slice(0, start).filter((l) => l.a !== null).pop()?.a ?? 0) + 1;
    const firstB = lines.find((l) => l.b !== null)?.b ?? (s.slice(0, start).filter((l) => l.b !== null).pop()?.b ?? 0) + 1;
    const aLines = lines.filter((l) => l.op !== "+").length, bLines = lines.filter((l) => l.op !== "-").length;
    // Unified-diff numbering: a side with no lines names the line after which the change goes (0 for the start).
    hunks.push({ aStart: aLines ? firstA : firstA - 1, aLines, bStart: bLines ? firstB : firstB - 1, bLines, lines });
    i = end;
  }
  return { hunks, added: s.filter((l) => l.op === "+").length, removed: s.filter((l) => l.op === "-").length, truncated, binary: false };
}

/** Unified diff text, as git prints it, for agents and plain views. */
export function unified(path: string, d: FileDiff): string {
  if (d.binary) return `Binary file ${path} changed\n`;
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of d.hunks) {
    out.push(`@@ -${h.aStart},${h.aLines} +${h.bStart},${h.bLines} @@`);
    for (const l of h.lines) out.push(`${l.op}${l.text}`);
  }
  if (d.truncated) out.push("(diff cut short: file too large)");
  return out.join("\n") + "\n";
}
