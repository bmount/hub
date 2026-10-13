// AI usage in the workbench: totals and breakdowns as the list, one person's or agent's calls in the inspector.
// Members see their own usage; admins see the whole organization. One D1 batch after optional filter lookups.
import type { Env } from "../env";
import { esc, htmlResponse, kitTable, toolbar, workbench } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { resolveUsageWork, resolveUsageProject, usageQueries, usageWorkGroups, type Group, type WorkGroup, type UsageWork, type UsageProject } from "../verbs/usage";
import { HubError } from "../errors";
import { fmtUsd, usageMoney } from "../models/usage";

type Call = { created_at: number; source: string; client: string | null; purpose: string; provider: string; model: string; input_tokens: number | null; output_tokens: number | null; cost_micros: number | null; cost_source: string | null; ok: number; ref: string | null };

const n = (x: number) => x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : String(x);
const cost = (g: Group) => esc(usageMoney(g));
const callCost = (c: Call) => c.cost_micros === null ? "price unknown" : `${fmtUsd(c.cost_micros)} · ${c.cost_source === "reported" ? "reported amount" : c.cost_source === "price" ? "API-rate estimate" : "unclassified amount"}`;

export async function usagePage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const admin = rank(ctx.role) >= rank("admin");
  const url = new URL(request.url);
  const days = [7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
  const since = ctx.now - days * 86_400_000;
  const whoParam = (url.searchParams.get("who") ?? "").trim().toLowerCase();
  const who = admin ? whoParam || null : ctx.identity.email;
  const scopeId = admin ? null : ctx.identity.id;
  let selectedWork: UsageWork | null;
  let selectedProject: UsageProject | null;
  try {
    selectedWork = await resolveUsageWork(ctx, url.searchParams.get("work"));
    selectedProject = await resolveUsageProject(ctx, url.searchParams.get("project"), selectedWork);
  } catch (e) { if (e instanceof HubError) return notFoundPage(extra); throw e; }
  const workQs = selectedWork ? `&work=${encodeURIComponent(selectedWork.ref)}` : "";
  const projectQs = selectedProject ? `&project=${encodeURIComponent(selectedProject.ref)}` : "";
  const filterQs = workQs + projectQs;
  const filterLabel = [selectedWork?.ref, selectedProject ? `project ${selectedProject.ref}` : null].filter(Boolean).join(" in ");
  const q = usageQueries(ctx.db, ctx.tenant.id, since, scopeId, selectedWork, selectedProject);
  const [t, w, m, s, d, work, calls] = await ctx.db.batch([q.total, q.byWho, q.byModel, q.bySource, q.byDay, q.byWork,
    ctx.db.prepare(`SELECT m.created_at, m.source, m.client, m.purpose, m.provider, m.model, m.input_tokens, m.output_tokens, m.cost_micros, m.cost_source, m.ok,
        CASE WHEN w.id IS NULL THEN NULL ELSE p.slug || '#' || w.number END AS ref
      FROM model_call m LEFT JOIN identity i ON i.id = m.identity_id
      LEFT JOIN work_item w ON w.id = m.work_item_id AND w.tenant_id = m.tenant_id AND w.project_id = m.project_id
      LEFT JOIN project p ON p.id = w.project_id AND p.tenant_id = m.tenant_id AND p.kind NOT IN ('channel', 'agent-src')
      WHERE m.tenant_id = ? AND m.created_at >= ? AND COALESCE(i.email, 'pimwell') = ?
        AND (? IS NULL OR (m.work_item_id = ? AND m.project_id = ?)) AND (? IS NULL OR m.project_id = ?)
      ORDER BY m.created_at DESC LIMIT 100`).bind(ctx.tenant.id, since, who ?? "", selectedWork?.id ?? null, selectedWork?.id ?? null, selectedWork?.project_id ?? null, selectedProject?.id ?? null, selectedProject?.id ?? null)]);
  const total = t!.results[0] as Group;
  const table = (title: string, rows: Group[], hrefFor?: (g: Group) => string | null) => rows.length ? `<h2>${esc(title)}</h2>${kitTable(title,[{label:"Group"},{label:"Calls"},{label:"Tokens in / out",className:"hide-s"},{label:"Amounts (USD)"}],rows.map(g=>{const href=hrefFor?.(g) ?? undefined; return {href,selected:who === g.key,cells:[{html:href ? `<a href="${esc(href)}">${esc(g.label)}</a>` : esc(g.label)},{html:String(g.calls)},{html:`${n(g.input_tokens)} / ${n(g.output_tokens)}<br><small>${g.input_known}/${g.calls} input and ${g.output_known}/${g.calls} output counts known</small>`,className:"hide-s"},{html:cost(g)}]};}))}` : "";
  const { byWork, byWorkCoverage } = usageWorkGroups(work!.results as WorkGroup[]);
  const workHref = (g: Group) => {
    const ref = (g as WorkGroup).ref;
    const match = ref && /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)#([1-9][0-9]{0,7})$/.exec(ref);
    return match ? `/${match[1]}/w/${match[2]}` : null;
  };
  const workHtml = table("By work item", byWork, workHref) + (total.calls ? `<p class="lede">${byWorkCoverage.shown} work groups shown${byWorkCoverage.truncated ? `; capped at ${byWorkCoverage.limit}, more groups omitted` : "; complete for recorded calls in this scope"}. Recorded calls only, not the full cost of the work. Unpriced calls are not zero-cost calls.</p>` : "");
  const dayRows = d!.results as Group[];
  const daysHtml = table("By day", dayRows);
  const range = [7, 30, 90].map((x) => `<a class="chip" href="${esc(`/usage?days=${x}${whoParam ? `&who=${encodeURIComponent(whoParam)}` : ""}${filterQs}`)}"${x === days ? ' aria-current="true"' : ""}>${x} days</a>`).join("");
  const filter = `<form class="filters" method="get" action="/usage"><input type="hidden" name="days" value="${days}">${whoParam ? `<input type="hidden" name="who" value="${esc(whoParam)}">` : ""}
<label>Project <input name="project" maxlength="127" value="${esc(selectedProject?.ref ?? "")}" placeholder="project or namespace/project"></label>
<label>Work item <input name="work" maxlength="80" value="${esc(selectedWork?.ref ?? "")}" placeholder="project#number"></label><button type="submit" class="quiet">Filter</button>
${selectedWork ? `<a href="${esc(`/usage?days=${days}${whoParam ? `&who=${encodeURIComponent(whoParam)}` : ""}${projectQs}`)}">Clear work filter</a>` : ""}
${selectedProject ? `<a href="${esc(`/usage?days=${days}${whoParam ? `&who=${encodeURIComponent(whoParam)}` : ""}${workQs}`)}">Clear project filter</a>` : ""}</form>`;
  const list = `<div class="head"><h1>AI usage</h1><span>${admin ? `everyone in ${esc(ctx.tenant.display_name)}` : "yours"}</span></div>
${toolbar("Usage range and filters",range,filter)}
${table("Totals",[{...total,key:"total",label:"Recorded calls"}])}
<p class="lede">${n(total.cached_tokens)} cached input tokens, included in input.</p>
<details><summary>Cost provenance and billing limits</summary><p class="lede">Reported amounts are not audited invoices. API-rate estimates are not charges. Rate-tier coverage (batch, long context, cache writes) is unknown.</p>
<p class="lede">Billing mode: unknown. The ledger does not record API/subscription evidence; OAuth alone does not establish billing mode or zero usage cost. Subscription fees are not configured here and are not allocated to calls.</p></details>
${total.calls ? "" : `<p class="empty">No AI usage recorded${filterLabel ? ` for ${esc(filterLabel)} in this period and scope` : " yet"}.${filterLabel ? ` This does not mean the ${selectedWork ? "work" : "project"} cost nothing.` : ""} Pimwell records its own calls; agents and people report theirs with usage_report, and apps log theirs (see the onboard skill).</p>`}
${admin ? table("By person or agent", w!.results as Group[], (g) => `/usage?days=${days}&who=${encodeURIComponent(g.key)}${filterQs}`) : ""}${table("By model", m!.results as Group[])}${table("By tool", s!.results as Group[])}${workHtml}${daysHtml}`;
  const callRows = calls!.results as Call[];
  const inspector = who ? `<a class="back" href="${esc(`/usage?days=${days}${filterQs}`)}">‹ AI usage</a><h1>${esc(who === "pimwell" ? "Pimwell" : who)}</h1>
${callRows.length ? kitTable("Recorded calls",[{label:"Call"},{label:"Usage"}],callRows.map(c=>({cells:[{html:`<time>${new Date(c.created_at).toISOString().slice(5,16).replace("T"," ")}</time><br><code>${esc(c.provider)}/${esc(c.model)}</code><br><small>${esc(c.client ?? c.source)}${c.ok ? "" : " · failed"}${c.ref ? ` · ${esc(c.ref)}` : ""}</small>`},{html:`${c.input_tokens === null ? "unknown" : n(c.input_tokens)} / ${c.output_tokens === null ? "unknown" : n(c.output_tokens)} tokens<br>${esc(callCost(c))}`}]}))) : '<p class="lede">No calls in this period.</p>'}` : null;
  return htmlResponse(workbench("AI usage", { list, stackOnPhone:true, listKey: `usage:${days}:${total.calls}:${selectedWork?.id ?? "all"}:${selectedProject?.id ?? "all"}`, inspector, inspectorKey: who ? `usage:${who}:${days}:${selectedWork?.id ?? "all"}:${selectedProject?.id ?? "all"}` : "" }, shellFor(ctx, env, "usage", "usage")!), 200, extra);
}
