import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Host-only release helper is JavaScript.
import { deployRecorder } from "../../scripts/deploy-record.mjs";
import { buildLocalTestWranglerConfig, readWranglerConfig } from "../wrangler-test-config";

describe("wrangler configuration", () => {
  it("starts a release reporting session before recording with a long-lived token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "release-report-"));
    try {
      const tokenFile = join(dir, "token");
      writeFileSync(tokenFile, "pmw_synthetic");
      const requests: Array<{ url: string; options: RequestInit }> = [];
      const fetchImpl = async (url: URL, options: RequestInit) => {
        requests.push({ url: String(url), options });
        return Response.json({ ok: true, result: String(url).endsWith("session.start")
          ? { session_token: "synthetic-session" }
          : String(url).endsWith("whoami") ? { identity: { email: "test@example.test" }, tenant: { role: "member" } }
          : { deploy: { id: "record-id" } } });
      };
      const report = await deployRecorder("pimwell", { tokenFile, fetchImpl });
      expect(await report({ worker: "pimwell-hub", version: "v", deployment: "d", deployed_at: 123 }, "a".repeat(40))).toEqual({ deploy: { id: "record-id" } });
      expect(requests.map(r => new URL(r.url).pathname)).toEqual(["/api/session.start", "/api/whoami", "/api/deploy.record"]);
      expect(JSON.parse(String(requests[0]!.options.body))).toEqual({ label: "make release", ttl: 3600 });
      expect(requests[0]!.options.headers).toMatchObject({ authorization: "Bearer pmw_synthetic" });
      for (const r of requests.slice(1)) expect(r.options.headers).toMatchObject({ authorization: "Bearer synthetic-session" });
      for (const r of requests) expect(r.options.redirect).toBe("error");
      await expect(deployRecorder("pimwell", { tokenFile, fetchImpl: async () => Response.json({ ok: false }, { status: 403 }) })).rejects.toThrow();
      await expect(deployRecorder("pimwell", { tokenFile, fetchImpl: async () => Response.json({ ok: true, result: {} }) })).rejects.toThrow("session missing");
    } finally { rmSync(dir, { recursive: true }); }
  });
  it("keeps the production Git artifact resources declared", () => {
    const config = readWranglerConfig();
    expect(config.vars).toMatchObject({
      GIT_BACKEND: "artifacts",
      ARTIFACTS_ACCOUNT_ID: "f48d61ea6cf57096b3f7bcb02fa0c3e5",
      ARDI_REPO_CREATE: "on",
    });
    expect(config.services).toContainEqual({ binding: "GIT_PROXY", service: "pimwell-git" });
    expect(config.r2_buckets).toContainEqual({ binding: "GIT_PUSH_STAGING", bucket_name: "pimwell-git-staging" });
  });

  it("removes production Git proxy defaults from local worker tests", () => {
    const config = buildLocalTestWranglerConfig();
    expect(config.vars).toMatchObject({ GIT_BACKEND: "" });
    expect(config.services ?? []).not.toContainEqual(expect.objectContaining({ binding: "GIT_PROXY" }));
    expect(config.r2_buckets).toContainEqual({ binding: "GIT_PUSH_STAGING", bucket_name: "pimwell-git-staging" });
  });
});
