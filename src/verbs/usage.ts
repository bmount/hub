// AI usage accounting (migration 0012): report usage from any tool, see it summed, and keep prices.
import { defineVerb } from "./table";
import { optString, reqString } from "./params";
import { badRequest, forbidden, notFound } from "../errors";
import { rank, type Ctx } from "../auth/context";
import { ulid } from "../ids";
import { recordEvent } from "../db/events";
import { DATA_NOTE, cleanText } from "../mcp/render";
import { USAGE_MONEY_COLUMNS, usageMoney, usageStatement, type UsageMoney } from "../models/usage";
import { itemRef } from "./work";
import { isValidSlug } from "../tenant";

const MAX_TOKENS = 50_000_000;
const tokens = (v: unknown, name: string, required: boolean): number | null => {
  if (v === undefined || v === null || v === "") { if (required) throw badRequest(`${name} is required`); return null; }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_TOKENS) throw badRequest(`${name} must be a whole number from 0 to ${MAX_TOKENS}`);
  return n;
};
const short = (v: unknown, name: string, max: number): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max || !/^[\w.:/@+-]+$/.test(v)) throw badRequest(`${name} must be a short name (letters, digits, . : / @ + - _)`);
  return v;
};

type Call = { provider: string; model: string; input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null; cost_micros: number | null; client: string | null; purpose: string; work: string | null; at: number | null };

function parseCall(c: Record<string, unknown>, now: number): Call {
  const provider = short(c.provider, "provider", 40); const model = short(c.model, "model", 80);
  if (!provider || !model) throw badRequest("provider and model are required");
  const cost = c.cost_usd;
  let cost_micros: number | null = null;
  if (cost !== undefined && cost !== null && cost !== "") {
    const d = typeof cost === "number" ? cost : Number(cost);
    if (!Number.isFinite(d) || d < 0 || d > 10_000) throw badRequest("cost_usd must be from 0 to 10000");
    cost_micros = Math.round(d * 1_000_000);
  }
  let at: number | null = null;
  if (typeof c.at === "string" && c.at) {
    at = Date.parse(c.at);
    if (!Number.isFinite(at) || at > now + 60_000 || at < now - 31 * 86_400_000) throw badRequest("at must be an ISO 8601 time within the last 31 days");
  }
  return {
    // Only provider and model are needed (owner, 2026-10-08): many tools never show token counts. Send what you know;
    // without tokens or a cost the call is still on the ledger, counted, and marked unpriced rather than guessed.
    provider: provider.toLowerCase(), model, input_tokens: tokens(c.input_tokens, "input_tokens", false), output_tokens: tokens(c.output_tokens, "output_tokens", false),
    cached_tokens: tokens(c.cached_tokens, "cached_tokens", false), cost_micros, client: short(c.client, "client", 40), purpose: short(c.purpose, "purpose", 40) ?? "agent",
    work: typeof c.work === "string" && c.work ? c.work.slice(0, 80) : null, at,
  };
}

const CALL_SCHEMA = {
  provider: { type: "string", description: "anthropic, openai, google, …" },
  model: { type: "string", description: "The model id as the provider names it" },
  input_tokens: { type: "integer", minimum: 0, description: "If your tool shows it; leave out otherwise" }, output_tokens: { type: "integer", minimum: 0, description: "If your tool shows it; leave out otherwise" },
  cached_tokens: { type: "integer", minimum: 0, description: "Of the input, how many were served from cache" },
  cost_usd: { type: "number", minimum: 0, description: "The cost your tool reports, if it does; otherwise Pimwell prices it" },
  client: { type: "string", description: "The tool that made the call: claude-code, codex, cursor, an app's name" },
  purpose: { type: "string", description: "What kind of work: coding, review, triage, …" },
  work: { type: "string", description: "The work item it was for, like pimwell#62" },
  at: { type: "string", description: "When, ISO 8601; default now" },
};

export const usageReport = defineVerb({
  name: "usage.report", kind: "command", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Report AI model usage from your own tools (one call, or up to 100 in calls), so every AI cost in this organization is on one ledger, attributed to you. Only provider and model are required; add tokens or cost if your tool shows them.",
  mcp: {
    scope: "write", destructive: false, title: "Report AI usage",
    input: { type: "object", properties: { ...CALL_SCHEMA, calls: { type: "array", maxItems: 100, items: { type: "object", properties: CALL_SCHEMA, additionalProperties: false }, description: "Several calls at once" } }, additionalProperties: false },
    render: (r) => { const x = r as { recorded: number; cost: string }; return `${DATA_NOTE}\n\nRecorded ${x.recorded} call(s), ${x.cost}.`; },
  },
  parse: (i) => i,
  run: async (ctx, i) => {
    const raw = Array.isArray(i.calls) ? (i.calls as unknown[]) : [i];
    if (!raw.length || raw.length > 100) throw badRequest("give one call, or 1 to 100 in calls");
    const calls = raw.map((c) => { if (!c || typeof c !== "object" || Array.isArray(c)) throw badRequest("each call is an object"); return parseCall(c as Record<string, unknown>, ctx.now); });
    const items = new Map<string, { id: string; project_id: string }>();
    for (const c of calls) if (c.work && !items.has(c.work)) { const w = await itemRef(ctx, { id: c.work }); items.set(c.work, { id: w.id, project_id: w.project_id }); }
    const ids = calls.map(() => ulid(ctx.now));
    await ctx.db.batch(calls.map((c, n) => usageStatement(ctx.db, {
      id: ids[n]!, source: "reported", purpose: c.purpose, provider: c.provider, model: c.model, tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id,
      session_id: ctx.session?.id ?? null, project_id: c.work ? items.get(c.work)!.project_id : null, work_item_id: c.work ? items.get(c.work)!.id : null,
      client: c.client, ok: true, ms: 0, input_tokens: c.input_tokens, output_tokens: c.output_tokens, cached_tokens: c.cached_tokens, reported_cost_micros: c.cost_micros, created_at: c.at ?? ctx.now,
    })));
    const sum = (await ctx.db.prepare(`SELECT ${USAGE_MONEY_COLUMNS} FROM model_call m WHERE m.tenant_id = ? AND m.identity_id = ? AND m.id IN (${ids.map(() => "?").join(",")})`).bind(ctx.tenant!.id, ctx.identity!.id, ...ids).first<UsageMoney>())!;
    return { recorded: calls.length, ...sum, cost: usageMoney(sum) };
  },
});

export type Group = UsageMoney & { key: string; label: string; input_tokens: number; output_tokens: number; cached_tokens: number; input_known: number; output_known: number };
export type WorkGroup = Group & { ref: string | null };
const WORK_GROUP_LIMIT = 50;

export function usageWorkGroups(rows: WorkGroup[]) {
  const byWork = rows.slice(0, WORK_GROUP_LIMIT);
  return { byWork, byWorkCoverage: { limit: WORK_GROUP_LIMIT, shown: byWork.length, truncated: rows.length > WORK_GROUP_LIMIT } };
}

export type UsageWork = { id: string; project_id: string; ref: string };

export async function resolveUsageWork(ctx: Ctx, reference: string | null): Promise<UsageWork | null> {
  if (reference === null || reference === "") return null;
  if (reference.length > 80) throw badRequest("work is too long");
  const item = await itemRef(ctx, { id: reference });
  const work = await ctx.db.prepare(`SELECT w.id, w.project_id, p.slug || '#' || w.number AS ref
    FROM work_item w JOIN project p ON p.id = w.project_id AND p.tenant_id = w.tenant_id AND p.kind <> 'channel'
    WHERE w.id = ? AND w.tenant_id = ?`).bind(item.id, ctx.tenant!.id).first<UsageWork>();
  if (!work) throw notFound("no such work item");
  return work;
}

export type UsageProject = { id: string; ref: string };

export async function resolveUsageProject(ctx: Ctx, reference: string | null, work: UsageWork | null): Promise<UsageProject | null> {
  if (reference === null || reference.trim() === "") return null;
  if (reference.length > 127) throw badRequest("project is too long");
  const parts = reference.trim().toLowerCase().split("/");
  const slug = parts.at(-1)!;
  const namespace = parts.length === 2 ? parts[0]! : null;
  if (parts.length > 2 || parts.some(p => !isValidSlug(p))) throw notFound("no such project");
  const project = await ctx.db.prepare(`SELECT p.id, CASE WHEN n.id IS NULL THEN p.slug ELSE n.slug || '/' || p.slug END AS ref
    FROM project p LEFT JOIN namespace n ON n.id = p.namespace_id AND n.tenant_id = p.tenant_id
    WHERE p.tenant_id = ? AND p.kind <> 'channel' AND p.slug = ?
      AND ((? IS NULL AND p.namespace_id IS NULL) OR n.slug = ?)`)
    .bind(ctx.tenant!.id, slug, namespace, namespace).first<UsageProject>();
  if (!project) throw notFound("no such project");
  if (work && work.project_id !== project.id) throw badRequest("work does not belong to project");
  return project;
}

export function usageQueries(db: D1Database, tenant_id: string, since: number, identity_id: string | null, work: UsageWork | null = null, project: UsageProject | null = null) {
  const where = `m.tenant_id = ? AND m.created_at >= ? AND (? IS NULL OR m.identity_id = ?)
    AND (? IS NULL OR (m.work_item_id = ? AND m.project_id = ?)) AND (? IS NULL OR m.project_id = ?)`;
  const args = [tenant_id, since, identity_id, identity_id, work?.id ?? null, work?.id ?? null, work?.project_id ?? null, project?.id ?? null, project?.id ?? null];
  const cols = `${USAGE_MONEY_COLUMNS}, COALESCE(SUM(m.input_tokens), 0) AS input_tokens, COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(m.cached_tokens), 0) AS cached_tokens, COUNT(m.input_tokens) AS input_known, COUNT(m.output_tokens) AS output_known`;
  return {
    total: db.prepare(`SELECT 'all' AS key, 'All' AS label, ${cols} FROM model_call m WHERE ${where}`).bind(...args),
    byWho: db.prepare(`SELECT COALESCE(i.email, 'pimwell') AS key, COALESCE(i.display_name, 'Pimwell') AS label, ${cols} FROM model_call m LEFT JOIN identity i ON i.id = m.identity_id WHERE ${where} GROUP BY m.identity_id ORDER BY SUM(m.cost_micros) DESC, calls DESC LIMIT 50`).bind(...args),
    byModel: db.prepare(`SELECT m.provider || '/' || m.model AS key, m.model AS label, ${cols} FROM model_call m WHERE ${where} GROUP BY m.provider, m.model ORDER BY SUM(m.cost_micros) DESC, calls DESC LIMIT 30`).bind(...args),
    bySource: db.prepare(`SELECT m.source || ':' || COALESCE(m.client, '') AS key, COALESCE(m.client, m.source) AS label, ${cols} FROM model_call m WHERE ${where} GROUP BY m.source, m.client ORDER BY calls DESC LIMIT 30`).bind(...args),
    byDay: db.prepare(`SELECT strftime('%Y-%m-%d', m.created_at / 1000, 'unixepoch') AS key, strftime('%m-%d', m.created_at / 1000, 'unixepoch') AS label, ${cols} FROM model_call m WHERE ${where} GROUP BY key ORDER BY key`).bind(...args),
    byWork: db.prepare(`SELECT CASE WHEN p.id IS NULL THEN 'unmatched' ELSE w.id END AS key,
        CASE WHEN p.id IS NULL THEN 'No matching work item' ELSE p.slug || '#' || w.number END AS label,
        CASE WHEN p.id IS NULL THEN NULL ELSE p.slug || '#' || w.number END AS ref, ${cols}
      FROM model_call m
      LEFT JOIN work_item w ON w.id = m.work_item_id AND w.tenant_id = m.tenant_id AND w.project_id = m.project_id
      LEFT JOIN project p ON p.id = w.project_id AND p.tenant_id = m.tenant_id AND p.kind <> 'channel'
      WHERE ${where} GROUP BY key ORDER BY cost_micros DESC, calls DESC, key LIMIT ${WORK_GROUP_LIMIT + 1}`).bind(...args),
  };
}

export const usageSummary = defineVerb({
  name: "usage.summary", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Recorded AI usage and cost over a period: totals, and by person or agent, model, tool, day and work item (up to 50 groups, with coverage). Yours by default; admins can see the whole organization. Optionally narrow to a project or work item.",
  mcp: {
    scope: "read", destructive: false, title: "AI usage",
    input: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 90, description: "Default 30" }, everyone: { type: "boolean", description: "Admins: the whole organization" }, work: { type: "string", maxLength: 80, description: "Optional work item reference or ID, like pimwell#1. Narrows the existing caller/organization scope." }, project: { type: "string", maxLength: 127, description: "Optional project path, like pimwell or team/site. Includes recorded calls without work items; never widens caller scope." } }, additionalProperties: false },
    render: (r) => {
      const x = r as { days: number; scope: string; work: string | null; project: string | null; total: Group; byWho: Group[]; byModel: Group[]; byWork: WorkGroup[]; byWorkCoverage: { limit: number; shown: number; truncated: boolean } };
      const line = (g: Group) => `- ${cleanText(g.label)}: ${g.calls} calls, ${g.input_tokens} in / ${g.output_tokens} out (${g.input_known}/${g.calls} input and ${g.output_known}/${g.calls} output counts known), ${usageMoney(g)}`;
      return [DATA_NOTE, "", `**AI usage, last ${x.days} days (${x.scope})${x.work ? ` for ${cleanText(x.work)}` : ""}${x.project ? ` in project ${cleanText(x.project)}` : ""}**`, line(x.total), "", "By person or agent:", ...x.byWho.map(line), "", "By model:", ...x.byModel.map(line), "", `By work item (${x.byWorkCoverage.shown} groups shown${x.byWorkCoverage.truncated ? `; capped at ${x.byWorkCoverage.limit}, more groups omitted` : "; complete for recorded calls in this scope"}):`, ...x.byWork.map(line), "Recorded calls only, not the full cost of the work. Unpriced calls are not zero-cost calls. Amounts are USD. Reported amounts are not audited invoices; API-rate estimates are not charges. Billing mode is unknown: the ledger does not record API/subscription evidence. Subscription fees are not configured here or allocated to calls. Rate-tier coverage (batch, long context, cache writes) is unknown."].join("\n");
    },
  },
  parse: (i) => {
    const d = i.days === undefined || i.days === "" ? 30 : Number(i.days);
    if (!Number.isInteger(d) || d < 1 || d > 90) throw badRequest("days must be from 1 to 90");
    return { days: d, everyone: i.everyone === true || i.everyone === "1" || i.everyone === "true", work: optString(i, "work", { max: 80 }), project: optString(i, "project", { max: 127 }) };
  },
  run: async (ctx, p) => {
    if (p.everyone && rank(ctx.role) < rank("admin")) throw forbidden("only admins see everyone's usage");
    const selectedWork = await resolveUsageWork(ctx, p.work);
    const selectedProject = await resolveUsageProject(ctx, p.project, selectedWork);
    const q = usageQueries(ctx.db, ctx.tenant!.id, ctx.now - p.days * 86_400_000, p.everyone ? null : ctx.identity!.id, selectedWork, selectedProject);
    const [t, w, m, s, d, work] = await ctx.db.batch([q.total, q.byWho, q.byModel, q.bySource, q.byDay, q.byWork]);
    return { days: p.days, scope: p.everyone ? "everyone" : "you", work: selectedWork?.ref ?? null, project: selectedProject?.ref ?? null, total: t!.results[0] as Group, byWho: w!.results as Group[], byModel: m!.results as Group[], bySource: s!.results as Group[], byDay: d!.results as Group[], ...usageWorkGroups(work!.results as WorkGroup[]) };
  },
});

export const modelPriceSet = defineVerb({
  name: "model.price_set", kind: "command", scope: "hub", minRole: "root", freshProofMinutes: 60, humanOnly: true,
  summary: "Set a model's price per million tokens, in US dollars, from now on. Calls already recorded keep their cost.",
  parse: (i) => {
    const num = (k: string, req: boolean) => {
      const v = i[k];
      if (v === undefined || v === "" || v === null) { if (req) throw badRequest(`${k} is required`); return null; }
      const d = Number(v);
      if (!Number.isFinite(d) || d < 0 || d > 10_000) throw badRequest(`${k} must be from 0 to 10000 dollars per million tokens`);
      return Math.round(d * 1_000_000);
    };
    return { provider: reqString(i, "provider", { max: 40 }).toLowerCase(), model: reqString(i, "model", { max: 80 }), input: num("input_usd", true)!, output: num("output_usd", true)!, cached: num("cached_input_usd", false), note: optString(i, "note", { max: 200 }) };
  },
  run: async (ctx, p) => {
    const id = ulid(ctx.now);
    await ctx.db.prepare("INSERT INTO model_price (id, provider, model, input_per_mtok, output_per_mtok, cached_input_per_mtok, effective_from, set_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, p.provider, p.model, p.input, p.output, p.cached, ctx.now, ctx.identity!.id, ctx.now).run();
    await recordEvent(ctx.db, { tenant_id: null, identity_id: ctx.identity!.id, session_id: ctx.session?.id ?? null, kind: "model.price_set", target_kind: "model_price", target_id: id,
      summary: `Priced ${p.provider}/${p.model}: $${p.input / 1e6} in, $${p.output / 1e6} out${p.cached !== null ? `, $${p.cached / 1e6} cached` : ""} per million tokens` }, ctx.now);
    return { id, provider: p.provider, model: p.model };
  },
});
