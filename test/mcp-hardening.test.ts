import { env } from "cloudflare:test";
import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcp } from "../src/mcp/handler";
import { takeRateAtomic } from "../src/rate";
import { seedHuman, seedTenant } from "./helpers";
import { LOOPBACK, authorize, connectWithTokens, pkce, register, registerClient } from "./oauth-helpers";

afterEach(() => vi.restoreAllMocks());

async function connected() {
  const acme = await seedTenant("acme");
  const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const c = await connectWithTokens(h.token);
  const grant = (await env.HUB_DB.prepare("SELECT * FROM oauth_grant").first<Record<string, any>>())!;
  return { acme, h, access: c.tokens.access_token, grant };
}

/** A minute-aligned clock a little past a boundary, so a run of calls cannot straddle two windows. */
const minuteStart = () => Math.floor(Date.now() / 60_000) * 60_000 + 1_000;

function call(token: string | null, now: number, opts: { ip?: string; body?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "cf-connecting-ip": opts.ip ?? "203.0.113.50" };
  if (token) headers.authorization = `Bearer ${token}`;
  const body = opts.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  return handleMcp(new Request("https://acme.pimwell.test/mcp", { method: "POST", headers, body }), env, undefined, now);
}

describe("/mcp JSON-RPC batches", () => {
  it("are refused with 400 and -32600 before the SDK sees them", async () => {
    const { access } = await connected();
    const batch = JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    const res = await call(access, Date.now(), { body: batch });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32600);
    expect((await call(access, Date.now())).status).toBe(200);
  });
});

describe("/mcp rate limits", () => {
  it("the 121st call in a minute is refused with Retry-After and exactly one mcp.denied event", async () => {
    const { access } = await connected();
    const now = minuteStart();
    for (let i = 0; i < 120; i++) expect((await call(access, now)).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      const res = await call(access, now);
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    const denied = await env.HUB_DB.prepare("SELECT summary FROM event WHERE kind = 'mcp.denied'").all<{ summary: string }>();
    expect(denied.results).toHaveLength(1);
    expect(denied.results[0]!.summary).toContain("mcp_grant_minute");
    expect((await call(access, now + 60_000)).status).toBe(200);
  });

  it("charges the per-IP bucket on invalid tokens as well as missing ones", async () => {
    const now = minuteStart();
    for (let i = 0; i < 30; i++) expect((await call(null, now, { ip: "198.51.100.1" })).status).toBe(401);
    for (let i = 0; i < 30; i++) expect((await call(`bad:token:${i}`, now, { ip: "198.51.100.1" })).status).toBe(401);
    const res = await call("bad:token:last", now, { ip: "198.51.100.1" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
    expect((await call("bad:token:other-ip", now, { ip: "198.51.100.2" })).status).toBe(401);
  });

  it("counts atomically in D1 and says `first` once", async () => {
    const now = minuteStart();
    const results = await Promise.all(Array.from({ length: 125 }, () => takeRateAtomic(env.HUB_DB, "mcp_grant_minute", "g-1", now)));
    expect(results.filter((r) => r.ok)).toHaveLength(120);
    expect(results.filter((r) => r.first)).toHaveLength(1);
    const row = await env.HUB_DB.prepare("SELECT count FROM rate_counter").first<{ count: number }>();
    expect(row!.count).toBe(125);
  });
});

describe("/mcp token validation", () => {
  it("answers 503 with Retry-After when validation throws, and 401 only for a genuine non-match", async () => {
    const { access } = await connected();
    const spy = vi.spyOn(OAuthAuthorizationServer.prototype, "validateToken").mockRejectedValue(new Error("KV unavailable"));
    const res = await call(access, Date.now());
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("www-authenticate")).toBeNull();
    spy.mockRestore();
    expect((await call(access, Date.now())).status).toBe(200);
    expect((await call("not:a:token", Date.now())).status).toBe(401);
  });

  it("refuses a token over 400 characters without calling the library, and charges the anon bucket", async () => {
    const spy = vi.spyOn(OAuthAuthorizationServer.prototype, "validateToken");
    const now = minuteStart();
    expect((await call(`a:b:${"c".repeat(400)}`, now, { ip: "198.51.100.30" })).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    for (let i = 0; i < 59; i++) await call(`a:b:${"c".repeat(400)}`, now, { ip: "198.51.100.30" });
    expect((await call(`a:b:${"c".repeat(400)}`, now, { ip: "198.51.100.30" })).status).toBe(429);
  });

  it("charges the anon bucket when validation throws, and fails open when KV errors", async () => {
    vi.spyOn(OAuthAuthorizationServer.prototype, "validateToken").mockRejectedValue(new Error("KV unavailable"));
    const now = minuteStart();
    for (let i = 0; i < 60; i++) expect((await call("a:b:c", now, { ip: "198.51.100.31" })).status).toBe(503);
    expect((await call("a:b:c", now, { ip: "198.51.100.31" })).status).toBe(429);
    const broken = { ...env, RATE: { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } } } as unknown as typeof env;
    const res = await handleMcp(new Request("https://acme.pimwell.test/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer a:b:c" }, body: "{}" }), broken, undefined, now);
    expect(res.status).toBe(503);
  });

  it("requires the token's client and user to be the grant's", async () => {
    const { access, grant } = await connected();
    expect((await call(access, Date.now())).status).toBe(200);
    await env.HUB_DB.prepare("UPDATE oauth_grant SET client_id = 'other' WHERE id = ?").bind(grant.id).run();
    expect((await call(access, Date.now())).status).toBe(401);
    await env.HUB_DB.prepare("UPDATE oauth_grant SET client_id = ? WHERE id = ?").bind(grant.client_id, grant.id).run();
    expect((await call(access, Date.now())).status).toBe(200);
  });
});

describe("input caps", () => {
  it("rejects a state longer than 1024 characters with an error page", async () => {
    const client_id = await registerClient();
    const { challenge } = await pkce();
    const long = await authorize({ client_id, challenge, state: "s".repeat(1025) });
    expect(long.status).toBe(400);
    expect(await long.text()).toContain("state value is too long");
    expect((await authorize({ client_id, challenge, state: "s".repeat(1024) })).status).toBe(302);
  });

  it("rejects a registration body over 8 KB", async () => {
    const meta = { redirect_uris: [LOOPBACK], token_endpoint_auth_method: "none" };
    const big = await register({ ...meta, client_name: "x".repeat(9000) });
    expect(big.status).toBe(413);
    expect((await register({ ...meta, client_name: "x".repeat(100) })).status).toBe(201);
  });
});
