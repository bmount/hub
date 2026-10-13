// /<project>/status: what happened lately, from the record only (src/verbs/status.ts).
import type { Env } from "../env";
import { esc, htmlResponse, kitList, kitTabs, toolbar, workbench } from "../html";
import { buildContext } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { HubError } from "../errors";
import { parseSince, projectStatus, statusExamples, statusFreshness } from "../verbs/status";
import { KINDS } from "../work/names";
import { sha256Hex } from "../ids";
import { selectedWorkInspector } from "./workPages";

export async function statusPage(request: Request, env: Env, slug: string): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const url = new URL(request.url);
  const sinceParam = url.searchParams.get("since") ?? "7d";
  let selected;
  try { selected = await selectedWorkInspector(ctx, env, url, slug); } catch (e) { if (e instanceof HubError && e.status === 404) return notFoundPage(extra); throw e; }
  const workHref = (ref: string) => { const u = new URL(url); u.searchParams.set("work", ref); return u.pathname + u.search; };
  let s;
  try { s = await projectStatus(ctx, slug, parseSince(sinceParam, ctx.now)); } catch (e) { if (e instanceof HubError && e.status === 404) return notFoundPage(extra); throw e; }
  const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const range = kitTabs("Status period", ["1d", "7d", "30d"].map(r => { const u = new URL(url); u.searchParams.set("since", r); u.searchParams.delete("work"); return {label:r === "1d" ? "Today" : r === "7d" ? "This week" : "30 days",href:u.pathname+u.search,current:r === sinceParam}; }));
  const sec = (title: string, n: number, shown: number, body: string) => n ? `<h2 title="${esc(statusExamples(n, shown))}">${esc(title)} <span class="wb-count">${n}</span></h2>${body}` : `<p class="lede">${esc(title)}: none</p>`;
  const list = `<div class="head"><h1>Status</h1><span>since ${when(s.since)}</span></div>${toolbar("Status actions and filters", range, '<input data-filter aria-label="Filter the list" placeholder="Filter these (/)" size="16">')}
<p class="lede" title="${esc(statusFreshness(s) + " " + s.coverage.note)}">Git sync: ${esc(s.coverage.git_sync.phase)} · ${s.coverage.telemetry.active_sources} active sources · ⓘ</p>
${sec("Under way now", s.totals.doing, s.doing.length, kitList("doing", s.doing.map((d) => ({href:workHref(d.ref),selected:url.searchParams.get("work") === d.ref,html:`<a href="${esc(workHref(d.ref))}">${esc(d.ref)}</a> ${esc(d.title)}${d.owner ? ` — ${esc(d.owner)}` : " — nobody"}${d.stalled ? ' <span class="pill">stalled</span>' : ""}`}))))}
${sec("Finished or let go", s.totals.finished, s.finished.length, kitList("finished", s.finished.map((f) => ({href:workHref(f.ref),selected:url.searchParams.get("work") === f.ref,html:`<a href="${esc(workHref(f.ref))}">${esc(f.ref)}</a> ${esc(f.title)}${f.state === "dropped" ? " (let go)" : ""}`}))))}
${sec("Filed", s.totals.filed, s.filed.length, kitList("filed", s.filed.map((f) => ({href:workHref(f.ref),selected:url.searchParams.get("work") === f.ref,html:`<a href="${esc(workHref(f.ref))}">${esc(f.ref)}</a> <span class="k-${f.kind}">${esc(KINDS[f.kind]?.name ?? f.kind)}</span> ${esc(f.title)}${f.by ? ` — ${esc(f.by)}` : ""}`}))))}
${sec("Commits", s.commits.count, s.commits.recent.length, `<p>${s.commits.by.map((b) => `${esc(b.who)}: ${b.n}`).join(" · ")}</p>${kitList("Commits", s.commits.recent.map(c=>({html:`${c.href ? `<a href="${esc(c.href)}">${esc(c.summary)}</a>` : esc(c.summary)}${c.oid ? ` <code>${esc(c.oid.slice(0, 12))}</code>` : ""} <small class="lede">${when(c.at)}</small>`})))}`)}
${sec("Deploys", s.totals.deploys, s.deploys.length, kitList("deploys", s.deploys.map((d) => ({html:`<a href="/apps?d=${esc(encodeURIComponent(d.id))}"><code>${esc(d.tag ?? d.script)}</code></a> ${when(d.at)}`}))))}
${sec("Error groups observed in period (including recurring)", s.totals.errors, s.errors.length, kitList("errors", s.errors.map((e) => ({html:`<a href="/apps?g=${esc(encodeURIComponent(e.id))}">${esc(e.title)}</a>: ${e.period_samples} retained period samples; ${e.lifetime_count} lifetime occurrences. First/last observed: ${when(e.first_seen)} / ${when(e.last_seen)}.`}))))}
${sec("Reviews updated in period", s.totals.reviews, s.reviews.length, kitList("reviews", s.reviews.map((r) => ({html:`<a href="/${esc(r.ref.replace("!", "/reviews/"))}">${esc(r.ref)}</a> ${esc(r.title)} (${esc(r.status)})`}))))}
<p class="lede">Admitted mail received: ${s.mail}. Comments on work: ${s.comments}.</p>`;
  const { since: _since, as_of: _asOf, ...records } = s;
  return htmlResponse(workbench(`${slug}: status`, { list, listKey: `status:${slug}:${sinceParam}:${await sha256Hex(JSON.stringify(records))}`, inspector: selected.html, inspectorKey: selected.key }, shellFor(ctx, env, "project", slug)!), 200, extra);
}
