import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("local worker test bindings", () => {
  it("starts without the production Git proxy binding or artifacts default", () => {
    const localEnv = env as unknown as Record<string, unknown>;
    expect(localEnv.GIT_PROXY).toBeUndefined();
    expect(localEnv.GIT_BACKEND).toBe("");
    expect(localEnv.ARDI).toBeDefined();
  });
});
