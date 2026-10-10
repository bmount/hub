// Reviews in the workbench: the list (the organization's, or one project's) and one review in the inspector with its
// diff, verdicts and comments. Integrating waits for Ardi's merge verb.
import type { Env } from "../env";
import { esc, htmlResponse, workbench } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { HubError } from "../errors";
import { readReview, reviewListStatement } from "../verbs/review";
import type { FileDiff } from "../code/diff";
import { KINDS, STATES } from "../work/names";
import { sha256Hex } from "../ids";

const ago = (ms: number, now: number) => { const m = Math.max(0, Math.round((now - ms) / 60_000)); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const STATUS: Record<string, string> = { open: "Waiting", approved: "Approved", changes: "Changes asked", closed: "Closed" };

function diffBlock(path: string, d: FileDiff | null, note: string | null): string {
  if (!d) return `<div class="head"><code>${esc(path)}</code></div><p class="lede">${esc(note ?? "")}</p>`;
  if (d.binary) return `<div class="head"><code>${esc(path)}</code></div><p class="lede">Binary file.</p>`;
  return `<div class="head"><code>${esc(path)}</code><span class="add">+${d.added}</span><span class="del">−${d.removed}</span></div><table class="diff"><tbody>${d.hunks.map((h) => `<tr class="hunk"><td colspan="3">@@ -${h.aStart},${h.aLines} +${h.bStart},${h.bLines} @@</td></tr>${h.lines.map((l) =>
    `<tr class="${l.op === "+" ? "ins" : l.op === "-" ? "dl" : ""}"><td class="ln">${l.a ?? ""}</td><td class="ln">${l.b ?? ""}</td><td><code>${esc(l.op + l.text)}</code></td></tr>`).join("")}`).join("")}</tbody></table>`;
}

export async function reviewsPage(request: Request, env: Env, slug: string | null, num: string | null): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  if (slug && !(await ctx.db.prepare("SELECT 1 FROM project WHERE tenant_id = ? AND slug = ? AND kind = 'repo'").bind(ctx.tenant.id, slug).first())) return notFoundPage(extra);
  const rows = (await reviewListStatement(ctx, slug, true).all<{ slug: string; number: number; title: string; branch: string; base: string; status: string; author: string; updated_at: number; mine: number }>()).results;
  const base = slug ? `/${esc(slug)}/reviews` : "/reviews";
  const list = `<div class="head"><h1>Reviews</h1><span>${rows.length} open${slug ? ` in ${esc(slug)}` : ""}</span></div>
<p class="lede">Ask people or agents to review a branch: over MCP with review_request, or tell the Assistant. Comments and verdicts are tied to the commit reviewed.</p>
${rows.length ? `<table><tbody>${rows.map((r) => `<tr data-href="/${esc(r.slug)}/reviews/${r.number}"${r.slug === slug && String(r.number) === num ? ' aria-selected="true"' : ""}><td class="ref">${esc(r.slug)}!${r.number}</td><td><a href="/${esc(r.slug)}/reviews/${r.number}">${esc(r.title)}</a>${r.mine ? ' <span class="pill">waiting on you</span>' : ""}<div class="lede" style="margin:0"><code>${esc(r.branch)}</code> into <code>${esc(r.base)}</code> · ${esc(r.author)}</div></td><td class="when">${esc(STATUS[r.status] ?? r.status)}</td><td class="when">${ago(r.updated_at, ctx.now)}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">No open reviews.</p>`}`;
  let inspector: string | null = null; let key = "";
  if (slug && num) {
    if (!/^\d{1,8}$/.test(num)) return notFoundPage(extra);
    let v;
    try { v = await readReview(ctx, `${slug}!${num}`); } catch (e) { if (e instanceof HubError && e.status === 404) return notFoundPage(extra); throw e; }
    const r = v.review;
    const canWrite = rank(ctx.role) >= rank("member");
    const back = `${base}`;
    const me = v.reviewers.find((x) => x.identity_id === ctx.identity!.id);
    inspector = `<a class="back" href="${back}">‹ Reviews</a><div class="head"><strong>${esc(r.slug)}!${r.number}</strong><span>${esc(STATUS[r.status] ?? r.status)}</span><code>${esc(r.branch)}</code><span>into</span><code>${esc(r.base)}</code></div>
<h1>${esc(r.title)}</h1>${r.summary ? `<div class="prose">${esc(r.summary)}</div>` : ""}
${canWrite ? `<p><a class="button" href="/new?review=${esc(encodeURIComponent(`${r.slug}!${r.number}`))}">File work from this review</a></p>` : ""}
<h2>Recorded work</h2>
<p class="lede">${v.relatedWorkCommit ? `Commit associations use ${esc(v.relatedWorkCommit)}, not the moving branch tip.` : "No supported full recorded commit; only explicit review URL associations are matched."} Recorded associations are not proof that this work was reviewed, approved or completed.</p>
${v.relatedWork.length ? `<table><tbody>${v.relatedWork.map(w => `<tr><td class="ref">${esc(w.ref)}</td><td>${esc(KINDS[w.kind].name)}</td><td><a href="/${esc(encodeURIComponent(w.project))}/w/${w.number}">${esc(w.title)}</a></td><td>${esc(STATES[w.state])}</td><td>${w.relationship}</td></tr>`).join("")}</tbody></table>` : `<p class="lede">No work associations recorded for this review.</p>`}
<p class="lede">${v.relatedWorkCoverage.shown} related work items shown${v.relatedWorkCoverage.truncated ? `; capped at ${v.relatedWorkCoverage.limit}, more omitted` : "; complete for recorded associations"}.</p>
<dl class="meta"><dt>Author</dt><dd>${esc(r.author)}</dd><dt>Reviewers</dt><dd>${v.reviewers.length ? v.reviewers.map((x) => `${esc(x.name)}: ${x.verdict ? (x.verdict === "approve" ? "approved" : "changes asked") : "waiting"}${x.stale ? " <small>(on an older commit)</small>" : ""}`).join("<br>") : "nobody named"}</dd>
<dt>Integrate</dt><dd><span class="pill">planned</span> waits for a merge verb in the git host</dd></dl>
${canWrite && r.author_id !== ctx.identity!.id && r.status !== "closed" ? `<form method="post" action="/api/review.verdict"><input type="hidden" name="id" value="${esc(r.slug)}!${r.number}"><input type="hidden" name="_back" value="/${esc(r.slug)}/reviews/${r.number}">
<label style="display:block"><textarea data-voice name="reason" rows="2" style="display:block;width:100%" placeholder="Your reasons (needed when asking for changes)">${esc(me?.reason ?? "")}</textarea></label>
<button type="submit" name="verdict" value="approve">Approve</button> <button type="submit" name="verdict" value="changes" class="quiet">Ask for changes</button></form>` : ""}
${canWrite ? `<form class="inline" method="post" action="/api/review.ai"><input type="hidden" name="id" value="${esc(r.slug)}!${r.number}"><input type="hidden" name="_back" value="/${esc(r.slug)}/reviews/${r.number}"><button type="submit" class="quiet">Ask the reviewer agent</button></form>` : ""}
<h2>Comments</h2>${v.comments.length ? `<ul class="timeline">${v.comments.map((c) => `<li><time>${ago(c.created_at, ctx.now)}</time><span><b>${esc(c.author)}</b>${c.path ? ` on <code>${esc(c.path)}${c.line ? `:${c.line}` : ""}</code>` : ""}<div class="prose" style="margin-top:2px">${esc(c.body)}</div></span></li>`).join("")}</ul>` : `<p class="lede">None yet.</p>`}
${canWrite ? `<form method="post" action="/api/review.comment"><input type="hidden" name="id" value="${esc(r.slug)}!${r.number}"><input type="hidden" name="_back" value="/${esc(r.slug)}/reviews/${r.number}">
<div class="row" style="display:flex;gap:6px;flex-wrap:wrap"><input name="path" placeholder="file (optional)" size="24"><input name="line" placeholder="line" size="5" inputmode="numeric"></div>
<label style="display:block"><textarea data-voice name="body" rows="3" required style="display:block;width:100%" placeholder="Comment"></textarea></label><button type="submit" class="quiet">Comment</button></form>` : ""}
<h2>Changes${v.diff ? ` <span class="pill">${v.diff.commits} commit${v.diff.commits === 1 ? "" : "s"}</span>` : ""}</h2>
${v.diff ? v.diff.files.map((f) => diffBlock(f.path, f.diff, f.note)).join("") : `<p class="lede">${esc(v.diff_error ?? "")}</p>`}`;
    key = `review:${r.id}:${r.updated_at}:${await sha256Hex(JSON.stringify([v.relatedWork, v.relatedWorkCoverage, v.relatedWorkCommit]))}`;
  }
  return htmlResponse(workbench(inspector ? `${slug}!${num}` : "Reviews", { list, listKey: `reviews:${slug ?? "org"}:${rows.length}`, inspector, inspectorKey: key }, shellFor(ctx, env, "reviews", slug ?? "reviews")!), 200, extra);
}
