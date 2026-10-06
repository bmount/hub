import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.HUB_DB, env.TEST_MIGRATIONS);
