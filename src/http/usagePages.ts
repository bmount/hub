// AI usage in the workbench: totals and breakdowns as the list, one person's or agent's calls in the inspector.
// Members see their own usage; admins see the whole organization. One D1 batch.
import type { Env } from "../env";
import { esc, htmlResponse, workbench } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { usageQueries } from "../verbs/usage";
import { fmtUsd } from "../models/usage";

type Group = { key: string; label: string; calls: number; input_tokens: number; output_tokens: number; cost_micros: number | null; unpriced: number };
type Call = { created_at: number; source: string; client: string | null; purpose: string; provider: string; model: string; input_tokens: number | null; output_tokens: number | null; cost_micros: number | null; ok: number; ref: string | null };

const n = (x: number) => x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : String(x);
const cost = (g: Group) => `${fmtUsd(g.cost_micros ?? (g.unpriced ? null : 0))}${g.unpriced && g.cost_micros !== null ? ` <small>+${g.unpriced} unpriced</small>` : ""}`;

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
  const q = usageQueries(ctx.db, ctx.tenant.id, since, scopeId);
  const [t, w, m, s, d, calls] = await ctx.db.batch([q.total, q.byWho, q.byModel, q.bySource, q.byDay,
    ctx.db.prepare(`SELECT m.created_at, m.source, m.client, m.purpose, m.provider, m.model, m.input_tokens, m.output_tokens, m.cost_micros, m.ok,
        CASE WHEN w.id IS NULL THEN NULL ELSE p.slug || '#' || w.number END AS ref
      FROM model_call m LEFT JOIN identity i ON i.id = m.identity_id LEFT JOIN work_item w ON w.id = m.work_item_id LEFT JOIN project p ON p.id = w.project_id
      WHERE m.tenant_id = ? AND m.created_at >= ? AND COALESCE(i.email, 'pimwell') = ? ORDER BY m.created_at DESC LIMIT 100`).bind(ctx.tenant.id, since, who ?? "")]);
  const total = t!.results[0] as Group;
  const table = (title: string, rows: Group[], link: boolean) => rows.length ? `<h2>${esc(title)}</h2><table><thead><tr><th></th><th>Calls</th><th class="hide-s">Tokens in / out</th><th>Cost</th></tr></thead><tbody>${rows.map((g) => {
    const href = `/usage?days=${days}&who=${encodeURIComponent(g.key)}`;
    return `<tr${link ? ` data-href="${esc(href)}"${who === g.key ? ' aria-selected="true"' : ""}` : ""}><td>${link ? `<a href="${esc(href)}">${esc(g.label)}</a>` : esc(g.label)}</td><td class="when">${g.calls}</td><td class="when hide-s">${n(g.input_tokens)} / ${n(g.output_tokens)}</td><td>${cost(g)}</td></tr>`;
  }).join("")}</tbody></table>` : "";
  const dayRows = d!.results as Group[];
  const peak = Math.max(1, ...dayRows.map((g) => g.calls));
  const daysHtml = dayRows.length ? `<h2>By day</h2><div class="bars">${dayRows.map((g) => `<div title="${esc(g.key)}: ${g.calls} calls, ${fmtUsd(g.cost_micros)}"><span style="height:${Math.max(2, Math.round((g.calls / peak) * 48))}px"></span><small>${esc(g.label.slice(3))}</small></div>`).join("")}</div>` : "";
  const range = [7, 30, 90].map((x) => `<a class="chip" href="/usage?days=${x}${whoParam ? `&who=${encodeURIComponent(whoParam)}` : ""}"${x === days ? ' aria-current="true"' : ""}>${x} days</a>`).join("");
  const list = `<div class="head"><h1>AI usage</h1><span>${admin ? `everyone in ${esc(ctx.tenant.display_name)}` : "yours"}</span></div>
<div class="chips">${range}</div>
<div class="grid"><div class="card"><div class="stat">${total.calls}<small>calls</small></div></div><div class="card"><div class="stat">${n(total.input_tokens + total.output_tokens)}<small>tokens</small></div></div><div class="card"><div class="stat">${cost(total)}</div><p>${total.unpriced ? `${total.unpriced} calls have no price yet` : "every call priced"}</p></div></div>
${total.calls ? "" : `<p class="empty">No AI usage recorded yet. Pimwell records its own calls; agents and people report theirs with usage_report, and apps log theirs (see the onboard skill).</p>`}
${admin ? table("By person or agent", w!.results as Group[], true) : ""}${table("By model", m!.results as Group[], false)}${table("By tool", s!.results as Group[], false)}${daysHtml}`;
  const callRows = calls!.results as Call[];
  const inspector = who ? `<a class="back" href="/usage?days=${days}">‹ AI usage</a><h1>${esc(who === "pimwell" ? "Pimwell" : who)}</h1>
${callRows.length ? `<table><thead><tr><th>When</th><th>Model</th><th class="hide-s">Tool</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${callRows.map((c) =>
    `<tr><td class="when">${new Date(c.created_at).toISOString().slice(5, 16).replace("T", " ")}</td><td><code>${esc(c.model)}</code>${c.ok ? "" : ' <span class="pill">failed</span>'}${c.ref ? ` <small>${esc(c.ref)}</small>` : ""}</td><td class="hide-s">${esc(c.client ?? c.source)}</td><td class="when">${n(c.input_tokens ?? 0)} / ${n(c.output_tokens ?? 0)}</td><td>${fmtUsd(c.cost_micros)}</td></tr>`).join("")}</tbody></table>` : `<p class="lede">No calls in this period.</p>`}` : null;
  return htmlResponse(workbench("AI usage", { list, listKey: `usage:${days}:${total.calls}`, inspector, inspectorKey: who ? `usage:${who}:${days}` : "" }, shellFor(ctx, env, "usage", "usage")!), 200, extra);
}
