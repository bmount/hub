// AI usage accounting (migration 0012): report usage from any tool, see it summed, and keep prices.
import { defineVerb } from "./table";
import { optString, reqString } from "./params";
import { badRequest, forbidden } from "../errors";
import { rank } from "../auth/context";
import { ulid } from "../ids";
import { recordEvent } from "../db/events";
import { DATA_NOTE, cleanText } from "../mcp/render";
import { fmtUsd, usageStatement } from "../models/usage";
import { itemRef } from "./work";

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
    const sum = await ctx.db.prepare(`SELECT SUM(cost_micros) AS c, SUM(cost_micros IS NULL) AS unknown FROM model_call WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).first<{ c: number | null; unknown: number }>();
    return { recorded: calls.length, cost_micros: sum?.c ?? null, unpriced: sum?.unknown ?? 0, cost: sum?.unknown ? `${fmtUsd(sum?.c ?? 0)} known, ${sum.unknown} unpriced` : fmtUsd(sum?.c ?? 0) };
  },
});

type Group = { key: string; label: string; calls: number; input_tokens: number; output_tokens: number; cost_micros: number | null; unpriced: number };

export function usageQueries(db: D1Database, tenant_id: string, since: number, identity_id: string | null) {
  const where = `m.tenant_id = ? AND m.created_at >= ? AND (? IS NULL OR m.identity_id = ?)`;
  const args = [tenant_id, since, identity_id, identity_id];
  const cols = "COUNT(*) AS calls, COALESCE(SUM(m.input_tokens), 0) AS input_tokens, COALESCE(SUM(m.output_tokens), 0) AS output_tokens, SUM(m.cost_micros) AS cost_micros, SUM(m.cost_micros IS NULL) AS unpriced";
  return {
    total: db.prepare(`SELECT 'all' AS key, 'All' AS label, ${cols} FROM model_call m WHERE ${where}`).bind(...args),
    byWho: db.prepare(`SELECT COALESCE(i.email, 'pimwell') AS key, COALESCE(i.display_name, 'Pimwell') AS label, ${cols} FROM model_call m LEFT JOIN identity i ON i.id = m.identity_id WHERE ${where} GROUP BY m.identity_id ORDER BY SUM(m.cost_micros) DESC, calls DESC LIMIT 50`).bind(...args),
    byModel: db.prepare(`SELECT m.provider || '/' || m.model AS key, m.model AS label, ${cols} FROM model_call m WHERE ${where} GROUP BY m.provider, m.model ORDER BY SUM(m.cost_micros) DESC, calls DESC LIMIT 30`).bind(...args),
    bySource: db.prepare(`SELECT m.source || ':' || COALESCE(m.client, '') AS key, COALESCE(m.client, m.source) AS label, ${cols} FROM model_call m WHERE ${where} GROUP BY m.source, m.client ORDER BY calls DESC LIMIT 30`).bind(...args),
    byDay: db.prepare(`SELECT strftime('%Y-%m-%d', m.created_at / 1000, 'unixepoch') AS key, strftime('%m-%d', m.created_at / 1000, 'unixepoch') AS label, ${cols} FROM model_call m WHERE ${where} GROUP BY key ORDER BY key`).bind(...args),
  };
}

export const usageSummary = defineVerb({
  name: "usage.summary", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "AI usage and cost over a period: totals, and by person or agent, model, tool, and day. Yours by default; admins can see the whole organization.",
  mcp: {
    scope: "read", destructive: false, title: "AI usage",
    input: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 90, description: "Default 30" }, everyone: { type: "boolean", description: "Admins: the whole organization" } }, additionalProperties: false },
    render: (r) => {
      const x = r as { days: number; scope: string; total: Group; byWho: Group[]; byModel: Group[] };
      const line = (g: Group) => `- ${cleanText(g.label)}: ${g.calls} calls, ${g.input_tokens} in / ${g.output_tokens} out, ${fmtUsd(g.cost_micros)}${g.unpriced ? ` (${g.unpriced} unpriced)` : ""}`;
      return [DATA_NOTE, "", `**AI usage, last ${x.days} days (${x.scope})**`, line(x.total), "", "By person or agent:", ...x.byWho.map(line), "", "By model:", ...x.byModel.map(line)].join("\n");
    },
  },
  parse: (i) => {
    const d = i.days === undefined || i.days === "" ? 30 : Number(i.days);
    if (!Number.isInteger(d) || d < 1 || d > 90) throw badRequest("days must be from 1 to 90");
    return { days: d, everyone: i.everyone === true || i.everyone === "1" || i.everyone === "true" };
  },
  run: async (ctx, p) => {
    if (p.everyone && rank(ctx.role) < rank("admin")) throw forbidden("only admins see everyone's usage");
    const q = usageQueries(ctx.db, ctx.tenant!.id, ctx.now - p.days * 86_400_000, p.everyone ? null : ctx.identity!.id);
    const [t, w, m, s, d] = await ctx.db.batch([q.total, q.byWho, q.byModel, q.bySource, q.byDay]);
    return { days: p.days, scope: p.everyone ? "everyone" : "you", total: t!.results[0] as Group, byWho: w!.results as Group[], byModel: m!.results as Group[], bySource: s!.results as Group[], byDay: d!.results as Group[] };
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
