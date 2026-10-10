import path from "node:path";
import { defineConfig, defineProject } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Storage is isolated per test file by the pool; test/apply-migrations.ts resets D1 and KV before every test,
// so each test still starts from an empty, migrated database.
const workers = defineProject({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(__dirname, "migrations")),
          HUB_DOMAIN: "pimwell.test",
          HUB_BOOTSTRAP_TOKEN: "test-bootstrap-token",
          HUB_INTERNAL_SECRET: "test-internal-secret",
          GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
          GOOGLE_CLIENT_SECRET: "test-google-secret",
          HUB_SECRETS_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          EVAL_KEY: "test-eval-key",
          ARDI_REPO_CREATE: "on",
        },
        // Stands in for the Ardi Worker: echoes what reached it, so tests can check the forward.
        serviceBindings: {
          async ARDI(request: Request) {
            const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array();
            // Making a repo project creates its repository (createRepo).
            if (new URL(request.url).pathname.endsWith("/api/repo.create")) return Response.json({ ok: true, result: { name: JSON.parse(new TextDecoder().decode(bytes)).name } });
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
    })),
  ],
  test: {
    // mailauth's transitive tldts uses extensionless ES imports. Bundle the
    // verifier entry point as in a Wrangler release, keeping native crypto.
    deps: { optimizer: { ssr: { enabled: true, include: ["mailauth/lib/dkim/dkim-verifier.js"],
      rolldownOptions: { external: [/^node:/, "buffer", "string_decoder"] } } } },
    // Only this checkout's tests: worktrees under .claude/worktrees hold other copies of test/.
    name: "workers",
    include: ["test/**/*.test.ts"],
    exclude: ["test/browser/**"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});

export default defineConfig({
  test: {
    // Checked references must fail when missing, not silently create new snapshots.
    update: "none",
    projects: [workers, {
      test: { name: "browser", include: ["test/browser/**/*.test.ts"], testTimeout: 30000, hookTimeout: 60000 },
    }],
  },
});
