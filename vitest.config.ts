import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              HUB_DOMAIN: "pimwell.test",
              HUB_BOOTSTRAP_TOKEN: "test-bootstrap-token",
              HUB_INTERNAL_SECRET: "test-internal-secret",
            },
          },
        },
      },
    },
  };
});
