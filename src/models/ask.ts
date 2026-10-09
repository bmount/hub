// The one way Pimwell asks a model anything (admin spec 10.6): resolve the purpose's route, use the scope's active
// key, record the call against the key and the purpose, and say which model answered.
import type { Env } from "../env";
import { ulid } from "../ids";
import { HubError } from "../errors";
import { provider as providerById, type AskResult, type Provider } from "./providers";
import { open } from "./secretbox";
import { activeCredentialRow, resolveRoute } from "./store";
import { usageStatement } from "./usage";
import { ModelCallTimeout, ModelCallCancelled } from "./deadline";

export type Answer = { text: string; purpose: string; provider: string; model: string; key_fingerprint: string; ms: number };

/** `client` names the process that made the call (default pimwell), so development and evals are told apart on the ledger. */
type CallOpts = { tenant_id?: string | null; identity_id?: string | null; session_id?: string | null; project_id?: string | null; work_item_id?: string | null; client?: string; now?: number; signal?: AbortSignal };

async function metered(
  env: Env, purposeId: string, opts: CallOpts,
  call: (p: Provider, key: string, model: string) => Promise<AskResult>,
): Promise<Answer> {
  const db = env.HUB_DB;
  const tenant_id = opts.tenant_id ?? null;
  const route = await resolveRoute(db, purposeId, tenant_id);
  const p = providerById(route.provider);
  if (!p) throw new HubError(503, "unavailable", `no provider ${route.provider}`);
  const cred = await activeCredentialRow(db, route.provider, tenant_id);
  if (!cred) throw new HubError(503, "unavailable", `no ${p.name} key: add one under Models and keys`);
  const started = Date.now();
  const now = opts.now ?? started;
  const record = (ok: boolean, inT: number | null, outT: number | null, error: string | null) =>
    db.batch([
      usageStatement(db, {
        id: ulid(now), source: "hub", purpose: purposeId, provider: route.provider, model: route.model, credential_id: cred.id, tenant_id,
        identity_id: opts.identity_id ?? null, session_id: opts.session_id ?? null, project_id: opts.project_id ?? null, work_item_id: opts.work_item_id ?? null,
        client: opts.client ?? "pimwell", ok, ms: Date.now() - started, input_tokens: inT, output_tokens: outT, error, created_at: now,
      }),
      ok
        ? db.prepare("UPDATE provider_credential SET last_used_at = ? WHERE id = ?").bind(now, cred.id)
        : db.prepare("UPDATE provider_credential SET last_used_at = ?, last_error = ?, last_error_at = ? WHERE id = ?").bind(now, error, now, cred.id),
    ]);
  try {
    const key = await open(env.HUB_SECRETS_KEY, { ciphertext: cred.secret_ciphertext, iv: cred.secret_iv });
    const r = await call(p, key, route.model);
    await record(true, r.inputTokens, r.outputTokens, null);
    return { text: r.text, purpose: purposeId, provider: route.provider, model: route.model, key_fingerprint: cred.fingerprint, ms: Date.now() - started };
  } catch (e) {
    if (e instanceof HubError) throw e;
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await record(false, null, null, msg);
    if (e instanceof ModelCallTimeout) throw new HubError(504, "provider_timeout", msg);
    if (e instanceof ModelCallCancelled) throw new HubError(408, "provider_cancelled", msg);
    throw new HubError(502, "provider_error", msg);
  }
}

export function ask(env: Env, purposeId: string, input: string, opts: CallOpts & { instructions?: string; maxOutputTokens?: number } = {}): Promise<Answer> {
  return metered(env, purposeId, opts, (p, key, model) => p.ask(key, model, input, { instructions: opts.instructions, maxOutputTokens: opts.maxOutputTokens, signal: opts.signal }));
}

/** Speech to text through the "transcribe" purpose's route. */
export function transcribe(env: Env, audio: Blob, filename: string, prompt: string, opts: CallOpts = {}): Promise<Answer> {
  return metered(env, "transcribe", opts, (p, key, model) => {
    if (!p.transcribe) throw new HubError(503, "unavailable", `${p.name} has no speech to text here`);
    return p.transcribe(key, model, audio, filename, prompt, { signal: opts.signal });
  });
}
