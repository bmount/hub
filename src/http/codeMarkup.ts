// Pure renderers: callers supply already-authorized repository and work records.
import { esc, kitTable, toolbar } from "../html";
import type { FileDiff } from "../code/diff";
import { KINDS, STATES, type WorkKind, type WorkState } from "../work/names";

export function recordedWorkTable(rows: { ref: string; project: string; number: number; title: string; kind: WorkKind; state: WorkState; relationship: string }[]): string {
  return kitTable("Recorded work", [{label:"Reference"},{label:"Kind"},{label:"Title"},{label:"State"},{label:"Relationship"}], rows.map(w => ({cells:[
    {html:esc(w.ref)},{html:esc(KINDS[w.kind].name)},{html:`<a href="/${esc(encodeURIComponent(w.project))}/w/${w.number}">${esc(w.title)}</a>`},{html:esc(STATES[w.state])},{html:esc(w.relationship)},
  ]})));
}

export function codeDiff(path: string, d: FileDiff | null, note: string | null, kind = ""): string {
  const head = toolbar("File changes", `<code>${esc(path)}</code>${kind ? `<span class="pill">${esc(kind)}</span>` : ""}${d && !d.binary ? `<span class="add">+${d.added}</span><span class="del">−${d.removed}</span>` : ""}`);
  if (!d || d.binary) return `${head}<p class="lede">${esc(d?.binary ? "Binary file." : note ?? "")}</p>`;
  const table = kitTable(`Changes in ${path}`, [{label:"Before"},{label:"After"},{label:"Change"}], d.hunks.flatMap(h => [
    {cells:[{html:"",className:"ln"},{html:"",className:"ln"},{html:`<code>@@ -${h.aStart},${h.aLines} +${h.bStart},${h.bLines} @@</code>`,className:"hunk"}]},
    ...h.lines.map(l => ({cells:[{html:String(l.a ?? ""),className:"ln"},{html:String(l.b ?? ""),className:"ln"},{html:`<code>${esc(l.op+l.text)}</code>`,className:l.op === "+" ? "ins" : l.op === "-" ? "dl" : ""}]})),
  ]));
  return `${head}<div class="wb-code">${table}</div>${d.truncated ? '<p class="lede">Cut short: the file is very large.</p>' : ""}`;
}
