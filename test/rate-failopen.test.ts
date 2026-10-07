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
  it("still deny, without a 500, when the over-limit marker read throws", async () => {
    const kv = stub({ get: async (k: unknown) => { if (String(k).endsWith(":over")) throw new Error("boom"); return "999"; } } as never);
    expect(await takeRateDetail(kv, "oauth_token_client", "c1", Date.now())).toMatchObject({ ok: false, first: false });
    expect(await takeRateDetail(kv, "mcp_grant_minute", "g1", Date.now())).toMatchObject({ ok: false, first: false });
  });
  it("keep the email buckets failing closed", async () => {
    await expect(takeRateDetail(stub({}), "addr", "a@example.com", Date.now())).rejects.toThrow("429");
  });
  it("treat a read failure as allowed only for per-grant MCP buckets", async () => {
    const kv = stub({ get: async () => { throw new Error("boom"); } });
    expect((await takeRateDetail(kv, "mcp_grant_hour", "g1", Date.now())).ok).toBe(true);
    await expect(takeRateDetail(kv, "ip", "x", Date.now())).rejects.toThrow("boom");
  });
  it("hand the counter write to defer without waiting, except for the fail-closed email buckets", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const kv = stub({ put: () => gate });
    const deferred: Promise<unknown>[] = [];
    // The write never settles until released, so an awaited write would hang this call.
    expect(await takeRateDetail(kv, "mcp_anon_ip", "198.51.100.40", Date.now(), (p) => deferred.push(p))).toMatchObject({ ok: true });
    expect(deferred).toHaveLength(1);
    let settled = false;
    const mail = takeRateDetail(kv, "addr", "a@example.com", Date.now(), (p) => deferred.push(p)).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(deferred).toHaveLength(1);
    release();
    await mail;
    expect(settled).toBe(true);
  });
});
