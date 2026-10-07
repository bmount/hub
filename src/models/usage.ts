// The AI usage ledger (migration 0012). Every model call anyone makes for this hub is a row in model_call: Pimwell's
// own (ask), what agents and people report from their own tools (usage.report), and what apps log for the telemetry
// worker. Cost is fixed when the call is recorded, from the price in effect then, inside the same INSERT.

export type UsageRow = {
  source: "hub" | "reported" | "app";
  purpose: string; provider: string; model: string;
  tenant_id: string | null; identity_id: string | null; session_id?: string | null;
  project_id?: string | null; work_item_id?: string | null; client?: string | null; credential_id?: string | null;
  ok: boolean; ms: number; input_tokens: number | null; output_tokens: number | null; cached_tokens?: number | null;
  error?: string | null; reported_cost_micros?: number | null; id: string; created_at: number;
};

const PRICE = `(SELECT (COALESCE(?, 0) * p.input_per_mtok + COALESCE(?, 0) * p.output_per_mtok + COALESCE(?, 0) * COALESCE(p.cached_input_per_mtok, p.input_per_mtok)) / 1000000
  FROM model_price p WHERE p.provider = ? AND p.model = ? AND p.effective_from <= ? ORDER BY p.effective_from DESC LIMIT 1)`;

/**
 * One statement that records a call and prices it. A reported cost wins over the price table; with neither, the cost
 * stays NULL ("price unknown") rather than a guess. Cached tokens are priced at the cached rate and are not also
 * counted as input.
 */
export function usageStatement(db: D1Database, r: UsageRow): D1PreparedStatement {
  const reported = r.reported_cost_micros ?? null;
  const uncachedIn = r.input_tokens === null ? null : Math.max(0, r.input_tokens - (r.cached_tokens ?? 0));
  return db.prepare(
    `INSERT INTO model_call (id, purpose, provider, model, credential_id, tenant_id, identity_id, ok, ms, input_tokens, output_tokens, error, created_at,
       source, session_id, project_id, work_item_id, client, cached_tokens, cost_micros, cost_source)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       COALESCE(?, ${PRICE}),
       CASE WHEN ? IS NOT NULL THEN 'reported' WHEN ${PRICE} IS NOT NULL THEN 'price' ELSE NULL END`,
  ).bind(
    r.id, r.purpose, r.provider, r.model, r.credential_id ?? null, r.tenant_id, r.identity_id, r.ok ? 1 : 0, r.ms, r.input_tokens, r.output_tokens, r.error ?? null, r.created_at,
    r.source, r.session_id ?? null, r.project_id ?? null, r.work_item_id ?? null, r.client ?? null, r.cached_tokens ?? null,
    reported, uncachedIn, r.output_tokens, r.cached_tokens ?? null, r.provider, r.model, r.created_at,
    reported, uncachedIn, r.output_tokens, r.cached_tokens ?? null, r.provider, r.model, r.created_at,
  );
}

export const dollars = (micros: number | null | undefined) => micros === null || micros === undefined ? null : micros / 1_000_000;
export const fmtUsd = (micros: number | null | undefined) => {
  if (micros === null || micros === undefined) return "price unknown";
  const d = micros / 1_000_000;
  return d === 0 ? "$0" : d < 0.01 ? `$${d.toFixed(4)}` : `$${d.toFixed(2)}`;
};
