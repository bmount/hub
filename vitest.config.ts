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
            // Stands in for the Ardi Worker: echoes what reached it, so tests can check the forward.
            serviceBindings: {
              async ARDI(request: Request) {
                const body = request.body ? await request.text() : "";
                return Response.json({
                  method: request.method, url: request.url, authorization: request.headers.get("authorization"),
                  cookie: request.headers.get("cookie"), gitProtocol: request.headers.get("git-protocol"),
                  contentType: request.headers.get("content-type"), body,
                }, { headers: { "x-ardi-stub": "1" } });
              },
            },
          },
        },
      },
    },
  };
});
