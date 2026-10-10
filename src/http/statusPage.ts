// /<project>/status: what happened lately, from the record only (src/verbs/status.ts).
import type { Env } from "../env";
import { esc, htmlResponse, workbench } from "../html";
import { buildContext } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { HubError } from "../errors";
import { parseSince, projectStatus, statusExamples, statusFreshness } from "../verbs/status";
import { KINDS } from "../work/names";
import { sha256Hex } from "../ids";

export async function statusPage(request: Request, env: Env, slug: string): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const sinceParam = new URL(request.url).searchParams.get("since") ?? "7d";
  let s;
  try { s = await projectStatus(ctx, slug, parseSince(sinceParam, ctx.now)); } catch (e) { if (e instanceof HubError && e.status === 404) return notFoundPage(extra); throw e; }
  const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const range = ["1d", "7d", "30d"].map((r) => `<a class="chip" href="/${esc(slug)}/status?since=${r}"${r === sinceParam ? ' aria-current="true"' : ""}>${r === "1d" ? "Today" : r === "7d" ? "This week" : "30 days"}</a>`).join("");
  const sec = (title: string, n: number, shown: number, body: string) => `<h2>${esc(title)} <span class="pill">${n}</span></h2><p class="lede">${esc(statusExamples(n, shown))}</p>${n ? body : '<p class="lede">No matching records observed.</p>'}`;
  const list = `<p class="crumbs"><a href="/">${esc(ctx.tenant.display_name)}</a> / <a href="/${esc(slug)}/docket">${esc(slug)}</a></p>
<div class="head"><h1>Status</h1><span>since ${when(s.since)}</span></div><div class="chips">${range}</div>
<p class="lede">Built from the record only: nothing here is written by a model.</p>
<p class="lede">${esc(statusFreshness(s))}</p><p class="lede">${esc(s.coverage.note)}</p>
${sec("Under way now", s.totals.doing, s.doing.length, `<ul>${s.doing.map((d) => `<li><a href="/${esc(d.ref.replace("#", "/w/"))}">${esc(d.ref)}</a> ${esc(d.title)}${d.owner ? ` — ${esc(d.owner)}` : " — nobody"}${d.stalled ? ' <span class="pill">stalled</span>' : ""}</li>`).join("")}</ul>`)}
${sec("Finished or let go", s.totals.finished, s.finished.length, `<ul>${s.finished.map((f) => `<li><a href="/${esc(f.ref.replace("#", "/w/"))}">${esc(f.ref)}</a> ${esc(f.title)}${f.state === "dropped" ? " (let go)" : ""}</li>`).join("")}</ul>`)}
${sec("Filed", s.totals.filed, s.filed.length, `<ul>${s.filed.map((f) => `<li><a href="/${esc(f.ref.replace("#", "/w/"))}">${esc(f.ref)}</a> <span class="k-${f.kind}">${esc(KINDS[f.kind]?.name ?? f.kind)}</span> ${esc(f.title)}${f.by ? ` — ${esc(f.by)}` : ""}</li>`).join("")}</ul>`)}
${sec("Commits", s.commits.count, s.commits.recent.length, `<p>${s.commits.by.map((b) => `${esc(b.who)}: ${b.n}`).join(" · ")}</p><ul>${s.commits.recent.map((c) => `<li>${c.href ? `<a href="${esc(c.href)}">${esc(c.summary)}</a>` : esc(c.summary)}${c.oid ? ` <code>${esc(c.oid.slice(0, 12))}</code>` : ""} <small class="lede">${when(c.at)}</small></li>`).join("")}</ul>`)}
${sec("Deploys", s.totals.deploys, s.deploys.length, `<ul>${s.deploys.map((d) => `<li><a href="/apps?d=${esc(encodeURIComponent(d.id))}"><code>${esc(d.tag ?? d.script)}</code></a> ${when(d.at)}</li>`).join("")}</ul>`)}
${sec("Error groups observed in period (including recurring)", s.totals.errors, s.errors.length, `<ul>${s.errors.map((e) => `<li><a href="/apps?g=${esc(encodeURIComponent(e.id))}">${esc(e.title)}</a>: ${e.period_samples} retained period samples; ${e.lifetime_count} lifetime occurrences. First/last observed: ${when(e.first_seen)} / ${when(e.last_seen)}.</li>`).join("")}</ul>`)}
${sec("Reviews updated in period", s.totals.reviews, s.reviews.length, `<ul>${s.reviews.map((r) => `<li><a href="/${esc(r.ref.replace("!", "/reviews/"))}">${esc(r.ref)}</a> ${esc(r.title)} (${esc(r.status)})</li>`).join("")}</ul>`)}
<p class="lede">Admitted mail received: ${s.mail}. Comments on work: ${s.comments}.</p>`;
  return htmlResponse(workbench(`${slug}: status`, { list, listKey: `status:${slug}:${sinceParam}:${await sha256Hex(JSON.stringify(s))}`, inspector: null }, shellFor(ctx, env, "project", slug)!), 200, extra);
}
