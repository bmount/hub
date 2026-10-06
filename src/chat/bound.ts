/**
 * Messaging spec 9.1, 9.2: a chat object stores its tenant and owner on first use and refuses any request that
 * asserts others. Object names already carry both, so a mismatch is a bug; failing loudly keeps it from leaking.
 */
export function bindOnce(sql: SqlStorage, tenant_id: string, owner_id: string): void {
  sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const rows = sql.exec<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('tenant_id', 'owner_id')").toArray();
  if (rows.length === 0) {
    sql.exec("INSERT INTO meta (key, value) VALUES ('tenant_id', ?), ('owner_id', ?)", tenant_id, owner_id);
    return;
  }
  const got = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (got.tenant_id !== tenant_id || got.owner_id !== owner_id) throw new Error("chat object is bound to another tenant or owner");
}

/** The stored binding, for alarms that run on a fresh instance. */
export function storedBinding(sql: SqlStorage): { tenant_id: string; owner_id: string } | null {
  sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const rows = sql.exec<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('tenant_id', 'owner_id')").toArray();
  const got = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return got.tenant_id && got.owner_id ? { tenant_id: got.tenant_id, owner_id: got.owner_id } : null;
}
