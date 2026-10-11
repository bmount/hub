import { describe, expect, it } from "vitest";
import { buildLocalTestWranglerConfig, readWranglerConfig } from "../wrangler-test-config";

describe("wrangler configuration", () => {
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
