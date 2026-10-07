import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

await applyD1Migrations(env.HUB_DB, env.TEST_MIGRATIONS);

const tables = (await env.HUB_DB.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'",
).all<{ name: string }>()).results.map((r) => r.name);

// Rows the migrations themselves insert (schema version, default allowlists) are restored after every wipe.
const seeds: Array<{ table: string; rows: Record<string, unknown>[] }> = [];
for (const t of tables) {
  const rows = (await env.HUB_DB.prepare(`SELECT * FROM "${t}"`).all<Record<string, unknown>>()).results;
  if (rows.length) seeds.push({ table: t, rows });
}
const reseed = seeds.flatMap(({ table, rows }) => rows.map((row) => {
  const cols = Object.keys(row);
  return env.HUB_DB.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...cols.map((c) => row[c] as unknown));
}));

async function emptyKv(kv: KVNamespace): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await kv.list({ cursor });
    await Promise.all(page.keys.map((k) => kv.delete(k.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

// The pool isolates storage per test file; every test here also starts from a freshly migrated database.
beforeEach(async () => {
  await env.HUB_DB.batch([
    env.HUB_DB.prepare("PRAGMA defer_foreign_keys = true"),
    ...tables.map((t) => env.HUB_DB.prepare(`DELETE FROM "${t}"`)),
    ...reseed,
  ]);
  await Promise.all([emptyKv(env.RATE), emptyKv(env.OAUTH_KV)]);
});
