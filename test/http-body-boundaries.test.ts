import { env, SELF, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/http/api";
import { MAX_API_BODY_BYTES, MAX_MCP_BODY_BYTES } from "../src/http/body";
import { handleMcp, handleAgentMcp } from "../src/mcp/handler";
import { registerEndpoint } from "../src/http/oauthRegister";
import { defineVerb, registerVerbs } from "../src/verbs/table";
import { takeRateDetail } from "../src/rate";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { connectWithTokens, rpcBody } from "./oauth-helpers";

const enc = new TextEncoder();
let ran = 0;
beforeAll(() => registerVerbs([defineVerb({ name: "test.body", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null,
  summary: "test bounded bodies", parse: (i) => i, run: async (_ctx, p) => { ran++; return { msg: p.msg ?? null }; } })]));
afterEach(() => vi.restoreAllMocks());

function chunked(url: string, bytes: Uint8Array, headers: Record<string, string> = {}) {
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) {
    if (offset === bytes.length) { c.close(); return; }
    const end = Math.min(bytes.length, offset + 8192); c.enqueue(bytes.subarray(offset, end)); offset = end;
  } }, { highWaterMark: 0 });
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

async function oauthConnected() {
  const t = await seedTenant("acme");
  const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const c = await connectWithTokens(h.token);
  return { h, access: c.tokens.access_token };
}
const mcpHeaders = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" });
const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

describe("API bounded parsing", () => {
  it.each<Record<string, string>>([{}, { "content-length": "1" }])("rejects oversized chunked JSON before dispatch %j", async (headers) => {
    const before = ran;
    const res = await handleApi(chunked("https://pimwell.test/api/test.body", enc.encode(JSON.stringify({ msg: "x".repeat(MAX_API_BODY_BYTES) })), headers), env);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, error: "too_large" });
    expect(ran).toBe(before);
  });

  it("accepts JSON exactly at the byte boundary", async () => {
    const body = JSON.stringify({ msg: "x".repeat(MAX_API_BODY_BYTES - 10) });
    expect(enc.encode(body).length).toBe(MAX_API_BODY_BYTES);
    const res = await handleApi(chunked("https://pimwell.test/api/test.body", enc.encode(body)), env);
    expect(res.status).toBe(200);
  });

  it.each(["application/x-www-form-urlencoded", "multipart/form-data; boundary=bound"])('refuses oversized %s with a safe form page', async (ct) => {
    const res = await handleApi(chunked("https://pimwell.test/api/test.body", enc.encode("x".repeat(MAX_API_BODY_BYTES + 1)), { "content-type": ct }), env);
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("request is too large");
  });

  it("parses bounded multipart forms without changing redirect semantics", async () => {
    const data = new FormData(); data.set("msg", "hi");
    const req = new Request("https://pimwell.test/api/test.body", { method: "POST", body: data });
    const res = await handleApi(req, env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("refuses cookie CSRF before reading and still hides tenant resources from anonymous callers", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const req = chunked("https://acme.pimwell.test/api/whoami", enc.encode("x".repeat(MAX_API_BODY_BYTES + 1)), { cookie: `pmw_session=${h.token}`, origin: "https://evil.example" });
    expect((await handleApi(req, env)).status).toBe(403);
    expect(req.bodyUsed).toBe(false);
    const anon = chunked("https://acme.pimwell.test/api/project.list", enc.encode("not JSON"));
    expect((await handleApi(anon, env)).status).toBe(404);
    expect(anon.bodyUsed).toBe(false);
  });

  it("rate-denies anonymous public calls before reading, even with invalid credentials", async () => {
    const ip = "198.51.100.201";
    const now = Date.now();
    for (let n = 0; n < 60; n++) await takeRateDetail(env.RATE, "api_anon_ip", ip, now);
    const req = chunked("https://pimwell.test/api/test.body", enc.encode("not JSON"), { "cf-connecting-ip": ip, authorization: "Bearer pmw_forged" });
    const res = await handleApi(req, env);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(req.bodyUsed).toBe(false);
  });

  it("actual Worker entry refuses oversize and preserves valid small calls", async () => {
    const res = await SELF.fetch("https://pimwell.test/api/whoami", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(MAX_API_BODY_BYTES) }) });
    expect(res.status).toBe(413);
    expect((await SELF.fetch("https://pimwell.test/api/whoami", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(200);
  });
});

describe("MCP bounded classification and dispatch", () => {
  it.each<Record<string, string>>([{}, { "content-length": "1" }])("refuses actual oversize after grant checks %j", async (headers) => {
    const { access } = await oauthConnected();
    const req = chunked("https://acme.pimwell.test/mcp", enc.encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", padding: "x".repeat(MAX_MCP_BODY_BYTES) })), { ...mcpHeaders(access), ...headers });
    const res = await handleMcp(req, env);
    expect(res.status).toBe(413);
    expect(await env.HUB_DB.prepare("SELECT 1 FROM event WHERE kind = 'mcp.call'").first()).toBeNull();
  });

  it("parses a valid body once for logging, batch check and SDK dispatch", async () => {
    const { access } = await oauthConnected();
    const req = chunked("https://acme.pimwell.test/mcp", enc.encode(rpc), mcpHeaders(access));
    const spy = vi.spyOn(JSON, "parse");
    const res = await handleMcp(req, env);
    expect(res.status).toBe(200);
    expect(spy.mock.calls.filter(([text]) => text === rpc)).toHaveLength(1);
    spy.mockRestore();
    expect((await rpcBody(res)).result.tools.length).toBeGreaterThan(0);
  });

  it("retains malformed JSON, wrong content-type and batch refusals", async () => {
    const { access } = await oauthConnected();
    const bad = await handleMcp(chunked("https://acme.pimwell.test/mcp", enc.encode("{"), mcpHeaders(access)), env);
    expect(bad.status).toBe(400);
    expect((await rpcBody(bad)).error.code).toBe(-32700);
    const ct = await handleMcp(chunked("https://acme.pimwell.test/mcp", enc.encode(rpc), { ...mcpHeaders(access), "content-type": "text/plain" }), env);
    expect(ct.status).toBe(415);
    const batch = await handleMcp(chunked("https://acme.pimwell.test/mcp", enc.encode(`[${rpc},${rpc}]`), mcpHeaders(access)), env);
    expect(batch.status).toBe(400);
    expect((await rpcBody(batch)).error.code).toBe(-32600);
  });

  it("does not read missing/invalid authentication or forbidden-origin bodies", async () => {
    for (const [handler, path] of [[handleMcp, "mcp"], [handleAgentMcp, "agent/mcp"]] as const) {
      for (const headers of [{}, { authorization: "Bearer invalid" }, { origin: "https://evil.example" }] as Record<string, string>[]) {
        const req = chunked(`https://acme.pimwell.test/${path}`, enc.encode("x".repeat(MAX_MCP_BODY_BYTES + 1)), headers);
        const res = await handler(req, env);
        expect([401, 403]).toContain(res.status);
        expect(req.bodyUsed).toBe(false);
      }
    }
  });

  it("uses the same bound for an authenticated headless agent", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const made = await apiPost("acme.pimwell.test", "agent.connect", { display_name: "Body tester" }, cookieHeaders(h.token, "acme.pimwell.test"));
    const link = ((await made.json()) as any).result.link;
    const claim = await SELF.fetch(link, { method: "POST", headers: { accept: "application/json" } });
    const token = ((await claim.json()) as any).token;
    expect(typeof token).toBe("string");
    const big = await handleAgentMcp(chunked("https://acme.pimwell.test/agent/mcp", enc.encode("x".repeat(MAX_MCP_BODY_BYTES + 1)), mcpHeaders(token)), env);
    expect(big.status).toBe(413);
    const small = await handleAgentMcp(chunked("https://acme.pimwell.test/agent/mcp", enc.encode(rpc), mcpHeaders(token)), env);
    expect(small.status).toBe(200);
  });
});

describe("OAuth registration bounded ingress", () => {
  it.each<Record<string, string>>([{}, { "content-length": "1" }])("refuses chunked oversized registration before JSON and client creation %j", async (headers) => {
    const res = await registerEndpoint(chunked("https://pimwell.test/oauth/register", enc.encode("x".repeat(8193)), headers), env, createExecutionContext());
    expect(res.status).toBe(413);
    expect(await env.HUB_DB.prepare("SELECT 1 FROM event WHERE kind = 'oauth.client.register'").first()).toBeNull();
  });

  it("rate checks precede all body consumption", async () => {
    const ip = "198.51.100.202";
    for (let n = 0; n < 10; n++) await takeRateDetail(env.RATE, "oauth_register_ip", ip, Date.now());
    const req = chunked("https://pimwell.test/oauth/register", enc.encode("invalid"), { "cf-connecting-ip": ip });
    expect((await registerEndpoint(req, env, createExecutionContext())).status).toBe(429);
    expect(req.bodyUsed).toBe(false);
  });
});
