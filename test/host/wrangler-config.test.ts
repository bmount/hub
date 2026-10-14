import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Host-only release helper is JavaScript.
import { deployRecorder } from "../../scripts/deploy-record.mjs";
// @ts-expect-error Host-only release helper is JavaScript.
import { compatibleBindings, compatibleRuntime } from "../../scripts/release-bindings.mjs";
import { buildLocalTestWranglerConfig, readWranglerConfig } from "../wrangler-test-config";

describe("wrangler configuration", () => {
  it("rolls back each Worker with its own non-versioned settings and refuses unknown targets", () => {
    const dir = mkdtempSync(join(tmpdir(), "rollback-"));
    try {
      writeFileSync(join(dir, "Makefile"), readFileSync("Makefile"));
      mkdirSync(join(dir, "scripts/cf"), { recursive: true });
      // Capture the actual recipe's arguments without credentials or a deployment.
      writeFileSync(join(dir, "scripts/cf/with-deploy-token.sh"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      const version = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      for (const [worker, config] of [
        ["", "wrangler.jsonc"], ["pimwell-hub", "wrangler.jsonc"],
        ["pimwell-git", "git-proxy/wrangler.jsonc"], ["pimwell-tail", "tail/wrangler.jsonc"],
      ]) {
        const result = spawnSync("make", ["--no-print-directory", "rollback", `VERSION=${version}`, `WORKER=${worker}`], { cwd: dir, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim().split("\n")).toEqual([
          "npx", "wrangler", "versions", "deploy", "-c", config!, "--name",
          worker || "pimwell-hub", `${version}@100%`, "--yes",
        ]);
      }
      for (const args of [["WORKER=unknown", `VERSION=${version}`], ["WORKER=pimwell-tail"]]) {
        const result = spawnSync("make", ["--no-print-directory", "rollback", ...args], { cwd: dir, encoding: "utf8" });
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe("");
      }
      const tail = readWranglerConfig(join(process.cwd(), "tail/wrangler.jsonc"));
      expect(tail.name).toBe("pimwell-tail");
      expect(tail.tail_consumers ?? []).not.toContainEqual(expect.objectContaining({ service: "pimwell-tail" }));
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("keeps bounded tracer CPU overhead below one millisecond (excluding native Analytics ingestion)", () => {
    const report = JSON.parse(execFileSync(process.execPath, ["scripts/perf-overhead.mjs"], { encoding: "utf8" }));
    for (const measurement of report.measurements) expect(measurement.overhead_cpu_ms).toBeLessThan(1);
  }, 15000);
  it("allows only the additive platform version metadata binding", () => {
    const resource = {name:"HUB_DB",type:"d1",id:"database"};
    const metadata = {name:"WORKER_VERSION",type:"version_metadata"};
    expect(compatibleBindings([resource], [metadata, resource])).toBe(true);
    expect(compatibleBindings([metadata, resource], [resource, metadata])).toBe(true);
    expect(compatibleBindings([metadata, resource], [resource])).toBe(false);
    expect(compatibleBindings([resource], [metadata, {...resource,id:"other"}])).toBe(false);
    expect(compatibleBindings([resource], [resource, {...metadata,type:"secret_text"}])).toBe(false);
    expect(readWranglerConfig().version_metadata).toEqual({binding:"WORKER_VERSION"});
  });
  it("permits only the exact additive performance dataset and tail async-context runtime", () => {
    const db = { name: "HUB_DB", type: "d1", id: "database" };
    const perf = { name: "PERF", type: "analytics_engine", dataset: "pimwell_perf" };
    expect(compatibleBindings([db], [db, perf])).toBe(true);
    const analytics={name:"PERF_ANALYTICS_TOKEN",type:"secret_text"};
    expect(compatibleBindings([db],[db,analytics])).toBe(true);
    expect(compatibleBindings([db],[db,{...analytics,name:"DEPLOY_TOKEN"}])).toBe(false);
    expect(compatibleBindings([db],[db,{...analytics,type:"plain_text"}])).toBe(false);
    expect(compatibleBindings([db,analytics],[db])).toBe(false);
    expect(compatibleBindings([db, perf], [perf, db])).toBe(true);
    expect(compatibleBindings([db, perf], [db])).toBe(false);
    expect(compatibleBindings([db], [db, { ...perf, dataset: "foreign" }])).toBe(false);
    expect(compatibleBindings([db], [db, { ...perf, type: "secret_text" }])).toBe(false);
    const runtime = { compatibility_date: "2026-09-01", compatibility_flags: [] };
    const fresh = { ...runtime, compatibility_flags: ["nodejs_compat"] };
    expect(compatibleRuntime(runtime, fresh, "pimwell-tail")).toBe(true);
    // Cloudflare omits an empty flags property and inserts a new one before usage_model.
    expect(compatibleRuntime({ compatibility_date: "2026-09-01", usage_model: "standard" },
      { compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat"], usage_model: "standard" }, "pimwell-tail")).toBe(true);
    expect(compatibleRuntime(runtime, fresh, "pimwell-hub")).toBe(false);
    expect(compatibleRuntime(runtime, { ...fresh, compatibility_date: "2027-01-01" }, "pimwell-tail")).toBe(false);
    expect(compatibleRuntime(runtime, { ...fresh, compatibility_flags: ["nodejs_compat", "other"] }, "pimwell-tail")).toBe(false);
    expect(readWranglerConfig().analytics_engine_datasets).toEqual([{ binding: "PERF", dataset: "pimwell_perf" }]);
  });
  it("allows only the additive hub public-fetch runtime required for same-zone public probes", () => {
    const runtime = { compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat"] };
    const fresh = { ...runtime, compatibility_flags: [...runtime.compatibility_flags, "global_fetch_strictly_public"] };
    expect(compatibleRuntime(runtime, fresh, "pimwell-hub")).toBe(true);
    for (const worker of ["pimwell-git", "pimwell-tail", undefined]) expect(compatibleRuntime(runtime, fresh, worker)).toBe(false);
    expect(compatibleRuntime(fresh, runtime, "pimwell-hub")).toBe(false);
    expect(compatibleRuntime(runtime, { ...fresh, compatibility_date: "2027-01-01" }, "pimwell-hub")).toBe(false);
    expect(compatibleRuntime(runtime, { ...fresh, compatibility_flags: [...fresh.compatibility_flags, "other"] }, "pimwell-hub")).toBe(false);
    expect(readWranglerConfig().compatibility_flags).toContain("global_fetch_strictly_public");
  });
  it("allows only the approved hub synthetic browser addition", () => {
    const db={name:"HUB_DB",type:"d1",id:"database"},browser={name:"SYNTHETIC_BROWSER",type:"browser"};
    expect(compatibleBindings([db],[db,browser],"pimwell-hub")).toBe(true);
    expect(compatibleBindings([db],[db,{...browser,version:2}],"pimwell-hub")).toBe(true);
    expect(compatibleBindings([db],[db,{...browser,version:3}],"pimwell-hub")).toBe(false);
    expect(compatibleBindings([db],[db,browser],"pimwell-tail")).toBe(false);
    expect(compatibleBindings([db],[db,{...browser,name:"OTHER"}],"pimwell-hub")).toBe(false);
    expect(compatibleBindings([db],[db,{...browser,type:"service"}],"pimwell-hub")).toBe(false);
    expect(compatibleBindings([db,browser],[db],"pimwell-hub")).toBe(false);
    expect(buildLocalTestWranglerConfig().browser).toBeUndefined();
  });
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
    expect(config.analytics_engine_datasets).toEqual([]);
    expect(config.services ?? []).not.toContainEqual(expect.objectContaining({ binding: "GIT_PROXY" }));
    expect(config.r2_buckets).toContainEqual({ binding: "GIT_PUSH_STAGING", bucket_name: "pimwell-git-staging" });
  });
});
