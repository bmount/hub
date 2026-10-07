// Provider credentials, model routes, and model calls in D1 (admin spec 10.2, 10.3).
import { ulid } from "../ids";
import { badRequest, conflict, notFound } from "../errors";
import { fingerprint, open, seal } from "./secretbox";
import { provider as providerById } from "./providers";
import { PURPOSES, purpose as purposeById } from "./purposes";

export type Credential = {
  id: string; tenant_id: string | null; provider: string; label: string; fingerprint: string;
  status: "active" | "standby" | "retired"; verified_at: number | null; verify_error: string | null;
  last_used_at: number | null; last_error: string | null; last_error_at: number | null;
  created_by: string | null; created_at: number; retired_at: number | null;
};
type SealedRow = Credential & { secret_ciphertext: string; secret_iv: string };

const PUBLIC_COLS = "id, tenant_id, provider, label, fingerprint, status, verified_at, verify_error, last_used_at, last_error, last_error_at, created_by, created_at, retired_at";

export async function listCredentials(db: D1Database, tenant_id: string | null = null): Promise<Credential[]> {
  const r = await db.prepare(`SELECT ${PUBLIC_COLS} FROM provider_credential WHERE IFNULL(tenant_id, '*') = IFNULL(?, '*') ORDER BY provider, status, created_at DESC`)
    .bind(tenant_id).all<Credential>();
  return r.results;
}

export async function getCredential(db: D1Database, id: string): Promise<Credential | null> {
  return db.prepare(`SELECT ${PUBLIC_COLS} FROM provider_credential WHERE id = ?`).bind(id).first<Credential>();
}

/**
 * Add a key: verify it with the provider first. A working key becomes active when the provider has no active key
 * in this scope, otherwise standby, so promotion (and rollback) is one deliberate step.
 */
export async function addCredential(
  db: D1Database, secretsKey: string | undefined,
  input: { provider: string; label: string; secret: string; tenant_id: string | null; created_by: string | null }, now: number,
): Promise<Credential> {
  const p = providerById(input.provider);
  if (!p) throw badRequest("unknown provider");
  const secret = input.secret.trim();
  if (!p.looksLikeKey(secret)) throw badRequest(`that does not look like an ${p.name} key`);
  const check = await p.verify(secret);
  if (!check.ok) throw badRequest(`${p.name} rejected the key: ${check.error}`);
  const active = await db.prepare("SELECT 1 FROM provider_credential WHERE provider = ? AND IFNULL(tenant_id, '*') = IFNULL(?, '*') AND status = 'active'")
    .bind(input.provider, input.tenant_id).first();
  const sealed = await seal(secretsKey, secret);
  const row: SealedRow = {
    id: ulid(now), tenant_id: input.tenant_id, provider: input.provider, label: input.label.trim() || p.name, fingerprint: fingerprint(secret),
    status: active ? "standby" : "active", verified_at: now, verify_error: null, last_used_at: null, last_error: null, last_error_at: null,
    created_by: input.created_by, created_at: now, retired_at: null, secret_ciphertext: sealed.ciphertext, secret_iv: sealed.iv,
  };
  await db.prepare(
    "INSERT INTO provider_credential (id, tenant_id, provider, label, secret_ciphertext, secret_iv, fingerprint, status, verified_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(row.id, row.tenant_id, row.provider, row.label, row.secret_ciphertext, row.secret_iv, row.fingerprint, row.status, row.verified_at, row.created_by, row.created_at).run();
  const { secret_ciphertext: _c, secret_iv: _i, ...pub } = row;
  return pub;
}

/** Make a standby key active; the previous active key becomes standby, so rolling back is the same action. */
export async function promoteCredential(db: D1Database, id: string): Promise<{ promoted: Credential; demoted: Credential | null }> {
  const c = await getCredential(db, id);
  if (!c) throw notFound("no such key");
  if (c.status === "active") throw conflict("that key is already active");
  if (c.status === "retired") throw conflict("a retired key cannot be promoted; add it again");
  const prev = await db.prepare(`SELECT ${PUBLIC_COLS} FROM provider_credential WHERE provider = ? AND IFNULL(tenant_id, '*') = IFNULL(?, '*') AND status = 'active'`)
    .bind(c.provider, c.tenant_id).first<Credential>();
  const stmts = [];
  if (prev) stmts.push(db.prepare("UPDATE provider_credential SET status = 'standby' WHERE id = ?").bind(prev.id));
  stmts.push(db.prepare("UPDATE provider_credential SET status = 'active' WHERE id = ?").bind(id));
  await db.batch(stmts);
  return { promoted: { ...c, status: "active" }, demoted: prev ? { ...prev, status: "standby" } : null };
}

/** Retire a standby key. The active key cannot be retired directly: promote its replacement first. */
export async function retireCredential(db: D1Database, id: string, now: number): Promise<Credential> {
  const c = await getCredential(db, id);
  if (!c) throw notFound("no such key");
  if (c.status === "active") throw conflict("promote another key before retiring the active one");
  if (c.status === "retired") throw conflict("already retired");
  // The ciphertext is wiped on retirement: a retired key is a record, not a credential.
  await db.prepare("UPDATE provider_credential SET status = 'retired', retired_at = ?, secret_ciphertext = '', secret_iv = '' WHERE id = ?").bind(now, id).run();
  return { ...c, status: "retired", retired_at: now };
}

export async function revealSecret(db: D1Database, secretsKey: string | undefined, id: string): Promise<string> {
  const row = await db.prepare("SELECT secret_ciphertext, secret_iv FROM provider_credential WHERE id = ? AND status != 'retired'").bind(id).first<{ secret_ciphertext: string; secret_iv: string }>();
  if (!row) throw notFound("no such key");
  return open(secretsKey, { ciphertext: row.secret_ciphertext, iv: row.secret_iv });
}

export async function reverifyCredential(db: D1Database, secretsKey: string | undefined, id: string, now: number): Promise<{ ok: boolean; error: string | null; models: string[] }> {
  const c = await getCredential(db, id);
  if (!c || c.status === "retired") throw notFound("no such key");
  const p = providerById(c.provider);
  if (!p) throw badRequest("unknown provider");
  const r = await p.verify(await revealSecret(db, secretsKey, id));
  await db.prepare("UPDATE provider_credential SET verified_at = ?, verify_error = ? WHERE id = ?").bind(now, r.ok ? null : r.error, id).run();
  return r.ok ? { ok: true, error: null, models: r.models } : { ok: false, error: r.error, models: [] };
}

export type Route = { purpose: string; provider: string; model: string; source: "default" | "hub" | "org" };

export async function resolveRoute(db: D1Database, purposeId: string, tenant_id: string | null): Promise<Route> {
  const p = purposeById(purposeId);
  if (!p) throw badRequest("unknown purpose");
  if (tenant_id) {
    const o = await db.prepare("SELECT provider, model FROM model_route WHERE purpose = ? AND tenant_id = ?").bind(purposeId, tenant_id).first<{ provider: string; model: string }>();
    if (o) return { purpose: purposeId, ...o, source: "org" };
  }
  const h = await db.prepare("SELECT provider, model FROM model_route WHERE purpose = ? AND tenant_id IS NULL").bind(purposeId).first<{ provider: string; model: string }>();
  if (h) return { purpose: purposeId, ...h, source: "hub" };
  return { purpose: purposeId, provider: p.provider, model: p.model, source: "default" };
}

export async function setRoute(db: D1Database, input: { purpose: string; provider: string; model: string; tenant_id: string | null; updated_by: string | null }, now: number): Promise<void> {
  if (!purposeById(input.purpose)) throw badRequest("unknown purpose");
  if (!providerById(input.provider)) throw badRequest("unknown provider");
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(input.model)) throw badRequest("invalid model name");
  await db.batch([
    db.prepare("DELETE FROM model_route WHERE purpose = ? AND IFNULL(tenant_id, '*') = IFNULL(?, '*')").bind(input.purpose, input.tenant_id),
    db.prepare("INSERT INTO model_route (id, purpose, tenant_id, provider, model, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(ulid(now), input.purpose, input.tenant_id, input.provider, input.model, input.updated_by, now),
  ]);
}

/** The active key for a provider: the organization's own if it has one, else the hub's. */
export async function activeCredentialRow(db: D1Database, providerId: string, tenant_id: string | null): Promise<SealedRow | null> {
  if (tenant_id) {
    const o = await db.prepare("SELECT * FROM provider_credential WHERE provider = ? AND tenant_id = ? AND status = 'active'").bind(providerId, tenant_id).first<SealedRow>();
    if (o) return o;
  }
  return db.prepare("SELECT * FROM provider_credential WHERE provider = ? AND tenant_id IS NULL AND status = 'active'").bind(providerId).first<SealedRow>();
}

export type PurposeStatus = {
  purpose: string; title: string; why: string; route: Route;
  key: { id: string; fingerprint: string; label: string; verified_at: number | null; verify_error: string | null } | null;
  calls_24h: number; errors_24h: number; needed: string | null;
};

/** What each purpose needs, what serves it now, and how it has been doing (admin spec 10.4). */
export async function purposeStatus(db: D1Database, tenant_id: string | null, now: number): Promise<PurposeStatus[]> {
  const out: PurposeStatus[] = [];
  for (const p of PURPOSES) {
    const route = await resolveRoute(db, p.id, tenant_id);
    const key = await activeCredentialRow(db, route.provider, tenant_id);
    const stats = await db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS e FROM model_call WHERE purpose = ? AND created_at > ?")
      .bind(p.id, now - 24 * 3600_000).first<{ n: number; e: number | null }>();
    const prov = providerById(route.provider);
    out.push({
      purpose: p.id, title: p.title, why: p.why, route,
      key: key ? { id: key.id, fingerprint: key.fingerprint, label: key.label, verified_at: key.verified_at, verify_error: key.verify_error } : null,
      calls_24h: stats?.n ?? 0, errors_24h: stats?.e ?? 0,
      needed: key ? (key.verify_error ? `the active ${prov?.name ?? route.provider} key failed its last check` : null) : `add an ${prov?.name ?? route.provider} key`,
    });
  }
  return out;
}
