// The one way Pimwell asks a model anything (admin spec 10.6): resolve the purpose's route, use the scope's active
// key, record the call against the key and the purpose, and say which model answered.
import type { Env } from "../env";
import { ulid } from "../ids";
import { HubError } from "../errors";
import { provider as providerById } from "./providers";
import { open } from "./secretbox";
import { activeCredentialRow, resolveRoute } from "./store";

export type Answer = { text: string; purpose: string; provider: string; model: string; key_fingerprint: string; ms: number };

export async function ask(
  env: Env, purposeId: string, input: string,
  opts: { tenant_id?: string | null; identity_id?: string | null; instructions?: string; maxOutputTokens?: number; now?: number } = {},
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
      db.prepare("INSERT INTO model_call (id, purpose, provider, model, credential_id, tenant_id, identity_id, ok, ms, input_tokens, output_tokens, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(ulid(now), purposeId, route.provider, route.model, cred.id, tenant_id, opts.identity_id ?? null, ok ? 1 : 0, Date.now() - started, inT, outT, error, now),
      ok
        ? db.prepare("UPDATE provider_credential SET last_used_at = ? WHERE id = ?").bind(now, cred.id)
        : db.prepare("UPDATE provider_credential SET last_used_at = ?, last_error = ?, last_error_at = ? WHERE id = ?").bind(now, error, now, cred.id),
    ]);
  try {
    const key = await open(env.HUB_SECRETS_KEY, { ciphertext: cred.secret_ciphertext, iv: cred.secret_iv });
    const r = await p.ask(key, route.model, input, { instructions: opts.instructions, maxOutputTokens: opts.maxOutputTokens });
    await record(true, r.inputTokens, r.outputTokens, null);
    return { text: r.text, purpose: purposeId, provider: route.provider, model: route.model, key_fingerprint: cred.fingerprint, ms: Date.now() - started };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await record(false, null, null, msg);
    throw new HubError(502, "provider_error", msg);
  }
}
