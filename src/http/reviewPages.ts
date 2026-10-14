import { projectPathSql } from "../db/projects";
// Reviews in the workbench: the list (the organization's, or one project's) and one review in the inspector with its
// diff, verdicts and comments. Integrating waits for Ardi's merge verb.
import type { Env } from "../env";
import { emptyState, esc, formRow, htmlResponse, inspectorSection, kitList, kitTable, statusChip, toolbar, workbench } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { HubError } from "../errors";
import { readReview, reviewListStatement } from "../verbs/review";
import { KINDS, STATES } from "../work/names";
import { resolveRepository, type Repository } from "../code/repositories";
import { sha256Hex } from "../ids";
import { codeDiff as diffBlock, recordedWorkTable } from "./codeMarkup";

const ago = (ms: number, now: number) => { const m = Math.max(0, Math.round((now - ms) / 60_000)); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const STATUS: Record<string, string> = { open: "Waiting", approved: "Approved", changes: "Changes asked", closed: "Closed" };

export async function reviewsPage(request: Request, env: Env, slug: string | null, num: string | null): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const project = slug ? await ctx.db.prepare(`/*perf-site:src%2Fhttp%2FreviewPages.ts:23:23:reviewsPage:0a8eb608*/ SELECT p.id FROM project p WHERE p.tenant_id = ? AND (${projectPathSql()}) = ? AND p.kind IN ('repo', 'workspace')`).bind(ctx.tenant.id, slug).first<{id:string}>() : null;
  if (slug && !project) return notFoundPage(extra);
  const url = new URL(request.url);
  let selectedRepo = url.searchParams.get("repo");
  let repoFilter: string | null = null;
  let repository: Repository | null = null;
  if (project) {
    try {
      const r = repository = await resolveRepository(ctx.db,ctx.tenant.id,project.id,selectedRepo);
      selectedRepo = r.name; url.searchParams.set("repo",r.name);
      repoFilter = r.is_default ? "" : r.name;
    } catch (e) { if (!(e instanceof HubError && e.status === 404)) throw e; if (selectedRepo) return notFoundPage(extra); }
  }
  const rows = (await reviewListStatement(ctx, slug, true, repoFilter).all<{ repo: string; repository_count: number; default_repository: string; slug: string; number: number; title: string; branch: string; base: string; status: string; author: string; updated_at: number; mine: number }>()).results;
  const filters = new URLSearchParams(url.search); filters.delete("work");
  const suffix = filters.size ? `?${filters}` : "";
  const reviewHref = (project: string, n: number, repo?: string) => {
    const q = new URLSearchParams(filters); if (repo) q.set("repo",repo); else if (repo === "" && !slug) q.delete("repo");
    return `/${project}/reviews/${n}${q.size ? `?${q}` : ""}`;
  };
  const base = slug ? `/${esc(slug)}/reviews` : "/reviews";
  const list = `<div class="head"><h1>Reviews</h1><span>${rows.length} open${slug ? ` in ${esc(slug)}` : ""}</span></div>
${toolbar("Review actions and filters", '<a href="/assistant">Ask for a review</a>', '<input data-filter aria-label="Filter the list" placeholder="Filter these (/)" size="16">')}
<p class="lede">Ask people or agents to review a branch: over MCP with review_request, or tell the Assistant. Comments and verdicts are tied to the commit reviewed.</p>
${rows.length ? kitTable("Reviews",[{label:"Reference"},{label:"Title"},{label:"Branch"},{label:"Author"},{label:"Status"},{label:"Updated"}],rows.map(r=>({href:reviewHref(r.slug,r.number,r.repo),selected:r.slug === slug && String(r.number) === num,cells:[{html:esc(r.slug)+"!"+r.number + (r.repository_count > 1 ? ` · ${esc(r.repo || r.default_repository)}` : "")},{html:`<a href="${esc(reviewHref(r.slug,r.number,r.repo))}">${esc(r.title)}</a>${r.mine ? ' <span class="pill">waiting on you</span>' : ""}`},{html:`<code>${esc(r.branch)}</code> into <code>${esc(r.base)}</code>`},{html:esc(r.author)},{html:statusChip(STATUS[r.status] ?? r.status,r.status === "approved" ? "done" : r.status === "changes" ? "blocked" : r.status === "closed" ? "dropped" : "open")},{html:ago(r.updated_at,ctx.now)}]}))) : emptyState("No open reviews", "Request a branch review over MCP or through the Assistant.", {label:"Ask the Assistant",href:"/assistant"})}`;
  let inspector: string | null = null; let key = "";
  if (slug && num) {
    if (!/^\d{1,8}$/.test(num)) return notFoundPage(extra);
    let v;
    try { v = await readReview(ctx, `${slug}!${num}`); } catch (e) { if (e instanceof HubError && e.status === 404) return notFoundPage(extra); throw e; }
    const r = v.review;
    if (repository && r.repo !== (repository.is_default ? "" : repository.name)) return notFoundPage(extra);
    const canWrite = rank(ctx.role) >= rank("member");
    const back = `${base}${esc(suffix)}`;
    const me = v.reviewers.find((x) => x.identity_id === ctx.identity!.id);
    inspector = `<a class="back" href="${back}">‹ Reviews</a><div class="head"><strong>${esc(r.slug)}!${r.number}</strong><span>${esc(STATUS[r.status] ?? r.status)}</span><code>${esc(r.branch)}</code><span>into</span><code>${esc(r.base)}</code></div>
<h1>${esc(r.title)}</h1>${r.summary ? `<div class="prose">${esc(r.summary)}</div>` : ""}
${toolbar("Review actions", (canWrite ? `<a class="button" href="/new?review=${esc(encodeURIComponent(`${r.slug}!${r.number}`))}">File work from this review</a>` : "") + (canWrite ? `<form class="inline" method="post" action="/api/review.ai"><input type="hidden" name="id" value="${esc(r.slug)}!${r.number}"><input type="hidden" name="_back" value="${esc(reviewHref(r.slug,r.number,r.repo))}"><button type="submit" class="quiet">Ask the reviewer agent</button></form>` : ""))}
<h2>Recorded work</h2>
<p class="lede">${v.relatedWorkCommit ? `Commit associations use ${esc(v.relatedWorkCommit)}, not the moving branch tip.` : "No supported full recorded commit; only explicit review URL associations are matched."} Recorded associations are not proof that this work was reviewed, approved or completed.</p>
${v.relatedWork.length ? recordedWorkTable(v.relatedWork) : `<p class="lede">No work associations recorded for this review.</p>`}
<p class="lede">${v.relatedWorkCoverage.shown} related work items shown${v.relatedWorkCoverage.truncated ? `; capped at ${v.relatedWorkCoverage.limit}, more omitted` : "; complete for recorded associations"}.</p>
${inspectorSection("Record", [{label:"Author",html:`${esc(r.author)}`},{label:"Reviewers",html:`${v.reviewers.length ? v.reviewers.map((x) => `${esc(x.name)}: ${x.verdict ? (x.verdict === "approve" ? "approved" : "changes asked") : "waiting"}${x.stale ? " <small>(on an older commit)</small>" : ""}`).join("<br>") : "nobody named"}`},{label:"Integrate",html:`<span class="pill">planned</span> waits for a merge verb in the git host`}])}
${canWrite && r.author_id !== ctx.identity!.id && r.status !== "closed" ? `<form method="post" action="/api/review.verdict"><input type="hidden" name="id" value="${esc(r.slug)}!${r.number}"><input type="hidden" name="_back" value="${esc(reviewHref(r.slug,r.number,r.repo))}">
${formRow("review-reason", "Reasons", `<textarea id="review-reason" data-voice name="reason" rows="2" placeholder="Required when asking for changes">${esc(me?.reason ?? "")}</textarea>`)}
<button type="submit" name="verdict" value="approve">Approve</button> <button type="submit" name="verdict" value="changes" class="quiet">Ask for changes</button></form>` : ""}

<h2>Comments</h2>${v.comments.length ? kitList("comments", v.comments.map((c)=>({html:`<time>${ago(c.created_at, ctx.now)}</time> · <span><b>${esc(c.author)}</b>${c.path ? ` on <code>${esc(c.path)}${c.line ? `:${c.line}` : ""}</code>` : ""}<div class="prose" style="margin-top:2px">${esc(c.body)}</div></span>`}))) : `<p class="lede">None yet.</p>`}
${canWrite ? `<form method="post" action="/api/review.comment"><input type="hidden" name="id" value="${esc(r.slug)}!${r.number}"><input type="hidden" name="_back" value="${esc(reviewHref(r.slug,r.number,r.repo))}">
${formRow("review-path","File (optional)", '<input id="review-path" name="path" size="24">')}${formRow("review-line","Line (optional)", '<input id="review-line" name="line" size="5" inputmode="numeric">')}${formRow("review-comment","Comment", '<textarea id="review-comment" data-voice name="body" rows="3" required></textarea>')}<button type="submit" class="quiet">Comment</button></form>` : ""}
<h2>Changes${v.diff ? ` <span class="pill">${v.diff.commits} commit${v.diff.commits === 1 ? "" : "s"}</span>` : ""}</h2>
${v.diff ? v.diff.files.map((f) => diffBlock(f.path, f.diff, f.note)).join("") : `<p class="lede">${esc(v.diff_error ?? "")}</p>`}`;
    key = `review:${r.id}:${r.updated_at}:${await sha256Hex(JSON.stringify([v.relatedWork, v.relatedWorkCoverage, v.relatedWorkCommit]))}`;
  }
  return htmlResponse(workbench(inspector ? `${slug}!${num}` : "Reviews", { list, listKey: `reviews:${slug ?? "org"}:${selectedRepo ?? ""}:${rows.length}`, inspector, inspectorKey: key }, shellFor(ctx, env, "reviews", slug ?? "reviews")!), 200, extra);
}
