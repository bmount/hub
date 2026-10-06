import { describe, expect, it } from "vitest";
import { takeRateDetail } from "../src/rate";

const stub = (over: Partial<Record<"get" | "put", () => Promise<unknown>>>) =>
  ({ get: async () => null, put: async () => { throw new Error("KV PUT failed: 429"); }, ...over }) as unknown as KVNamespace;

describe("rate counters", () => {
  it("fail open when the KV write throws", async () => {
    expect(await takeRateDetail(stub({}), "mcp_grant_minute", "g1", Date.now())).toMatchObject({ ok: true });
  });
  it("still deny over the limit when the marker write throws", async () => {
    const kv = stub({ get: async (k: unknown) => (String(k).endsWith(":over") ? null : "999") } as never);
    expect(await takeRateDetail(kv, "mcp_grant_minute", "g1", Date.now())).toMatchObject({ ok: false, first: true });
  });
  it("keep the email buckets failing closed", async () => {
    await expect(takeRateDetail(stub({}), "addr", "a@example.com", Date.now())).rejects.toThrow("429");
  });
  it("treat a read failure as allowed only for per-grant MCP buckets", async () => {
    const kv = stub({ get: async () => { throw new Error("boom"); } });
    expect((await takeRateDetail(kv, "mcp_grant_hour", "g1", Date.now())).ok).toBe(true);
    await expect(takeRateDetail(kv, "ip", "x", Date.now())).rejects.toThrow("boom");
  });
});
