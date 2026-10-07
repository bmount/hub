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
              GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
              GOOGLE_CLIENT_SECRET: "test-google-secret",
              HUB_SECRETS_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
            },
            // Stands in for the Ardi Worker: echoes what reached it, so tests can check the forward.
            serviceBindings: {
              async ARDI(request: Request) {
                const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array();
                if (request.headers.get("x-stub-401")) return new Response("denied\n", { status: 401, headers: { "www-authenticate": 'Basic realm="ardi"', "x-ardi-stub": "1" } });
                const body = bytes.length > 4096 ? "" : new TextDecoder().decode(bytes);
                return Response.json({
                  length: bytes.length, xArdi: [...request.headers.keys()].filter((k) => k.startsWith("x-ardi-")),
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
