import { createExecutionContext, env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_AUTH_FORM_BODY_BYTES, MAX_OAUTH_TOKEN_BODY_BYTES } from "../src/http/body";
import { loginPostPage } from "../src/http/login";
import { consentPost } from "../src/http/oauthAuthorize";
import { tokenEndpoint } from "../src/oauth/token";
import { sha256Hex } from "../src/ids";
import { RATE_RULES, type RateBucket } from "../src/rate";
import { grantConsent } from "../src/db/consent";
import { setTestTransport, type SentMail } from "../src/mail/send";
import { cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { authorize, connect, connectWithTokens, decide, formTokenOf, pendingIdOf, pkce, registerClient, resourceFor, tokenRequest, viewConsent } from "./oauth-helpers";

const enc = new TextEncoder();
const sent: SentMail[] = [];
beforeEach(() => setTestTransport(async (m) => { sent.push(m); }));
afterEach(() => { sent.length = 0; setTestTransport(null); vi.restoreAllMocks(); });

function streamed(path: string, text: string, headers: Record<string, string> = {}) {
  const bytes = enc.encode(text);
  let offset = 0, pulls = 0, cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulls++;
      if (offset === bytes.length) { c.close(); return; }
      const end = Math.min(bytes.length, offset + 1024);
      c.enqueue(bytes.subarray(offset, end)); offset = end;
    },
    cancel() { cancelled++; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  const request = new Request(`https://pimwell.test${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body });
  return { request, stats: () => ({ pulls, cancelled }) };
}
async function denyRate(bucket: RateBucket, subject: string, now: number) {
  const rule = RATE_RULES[bucket];
  await env.RATE.put(`rl:${bucket}:${Math.floor(now / rule.windowMs)}:${await sha256Hex(subject.trim().toLowerCase())}`, String(rule.limit));
}
const grant = () => env.HUB_DB.prepare("SELECT * FROM oauth_grant").first();

async function member() {
  const t = await seedTenant("acme");
  return seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
}
async function viewed() {
  const h = await member();
  const client_id = await registerClient();
  const { challenge } = await pkce();
  const id = pendingIdOf(await authorize({ client_id, challenge }));
  const form_token = formTokenOf(await (await viewConsent(id, h.token)).text());
  return { h, id, form_token };
}

// These tests call the actual Workers handlers with chunked absent/forged length
// streams. A stalled cancellation must never delay refusal or permit effects.
describe("OAuth token/revoke actual-byte ingress", () => {
  it.each(["/oauth/token", "/oauth/revoke"])("bounds %s before credential/grant effects", async (path) => {
    const h = await member();
    const c = await connectWithTokens(h.token);
    const before = await grant();
    const fields: Record<string, string> = path.endsWith("revoke") ? { token: c.tokens.refresh_token, client_id: c.client_id } : { grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: c.client_id };
    const text = new URLSearchParams(fields).toString() + "&padding=" + "x".repeat(MAX_OAUTH_TOKEN_BODY_BYTES);
    const { request, stats } = streamed(path, text, { "content-length": "1" });
    const res = await tokenEndpoint(request, env, createExecutionContext());
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(stats().cancelled).toBe(1);
    expect(request.body!.locked).toBe(false);
    expect(await grant()).toEqual(before);
    expect(await env.HUB_DB.prepare("SELECT 1 FROM event WHERE kind = 'oauth.grant.revoke'").first()).toBeNull();
  });

  it("does not consume an authorization code on overflow; bounded code exchange removes forged framing", async () => {
    const h = await member();
    const c = await connect(h.token);
    const fields = { grant_type: "authorization_code", code: c.code, redirect_uri: c.redirect, client_id: c.client_id, code_verifier: c.verifier, resource: resourceFor("acme") };
    const text = new URLSearchParams(fields).toString();
    expect((await tokenEndpoint(streamed("/oauth/token", text + "&x=" + "x".repeat(MAX_OAUTH_TOKEN_BODY_BYTES)).request, env, createExecutionContext())).status).toBe(413);
    const good = streamed("/oauth/token", text, { "content-length": "1", "transfer-encoding": "chunked" });
    expect((await tokenEndpoint(good.request, env, createExecutionContext())).status).toBe(200);
    expect((await grant() as any).refresh_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each<Record<string, string>>([{}, { "content-length": "0" }, { "content-length": "bad" }])("counts actual bytes with length %j", async (headers) => {
    const res = await tokenEndpoint(streamed("/oauth/token", "x".repeat(MAX_OAUTH_TOKEN_BODY_BYTES + 1), headers).request, env, createExecutionContext());
    expect(res.status).toBe(413);
  });

  it("accepts exactly the token byte cap and applies the existing protocol error", async () => {
    const base = "grant_type=password&client_id=boundary&padding=";
    const res = await tokenEndpoint(streamed("/oauth/token", base + "x".repeat(MAX_OAUTH_TOKEN_BODY_BYTES - enc.encode(base).length)).request, env, createExecutionContext());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported_grant_type" });
  });

  it("rejects a declared oversize before pulling and leaves client quota untouched", async () => {
    const s = streamed("/oauth/token", "client_id=unused", { "content-length": String(MAX_OAUTH_TOKEN_BODY_BYTES + 1) });
    expect((await tokenEndpoint(s.request, env, createExecutionContext())).status).toBe(413);
    expect(s.stats()).toEqual({ pulls: 0, cancelled: 1 });
    expect((await env.RATE.list({ prefix: "rl:oauth_token_client:" })).keys).toHaveLength(0);
  });

  it.each(["/oauth/token", "/oauth/revoke"])("IP denial precedes all reads at %s", async (path) => {
    const now = 1234 * 60000, ip = "198.51.100.211";
    await denyRate("oauth_token_ip", ip, now);
    const s = streamed(path, "x".repeat(MAX_OAUTH_TOKEN_BODY_BYTES + 1), { "cf-connecting-ip": ip });
    const res = await tokenEndpoint(s.request, env, createExecutionContext(), now);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(s.stats().pulls).toBe(0);
    expect(s.request.bodyUsed).toBe(false);
  });

  it("client denial follows bounded parsing and leaves genuine tokens untouched", async () => {
    const h = await member();
    const c = await connectWithTokens(h.token);
    const before = await grant();
    const now = Date.now();
    await denyRate("oauth_token_client", c.client_id, now);
    const s = streamed("/oauth/revoke", new URLSearchParams({ client_id: c.client_id, token: c.tokens.refresh_token }).toString());
    expect((await tokenEndpoint(s.request, env, createExecutionContext(), now)).status).toBe(429);
    expect(s.request.bodyUsed).toBe(true);
    expect(await grant()).toEqual(before);
  });

  it("host and media refusals precede reading", async () => {
    const s = streamed("/oauth/token", "oversized", { "content-type": "application/json" });
    expect((await tokenEndpoint(s.request, env, createExecutionContext())).status).toBe(400);
    expect(s.request.bodyUsed).toBe(false);
    const req = new Request("https://acme.pimwell.test/oauth/token", { method: "POST", body: "x", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect((await tokenEndpoint(req, env, createExecutionContext())).status).toBe(404);
    expect(req.bodyUsed).toBe(false);
  });

  it("maps stream errors safely without revealing exception text", async () => {
    const req = new Request("https://pimwell.test/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new ReadableStream({ start(c) { c.error(new Error("private credential detail")); } }) });
    const res = await tokenEndpoint(req, env, createExecutionContext());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("production entry returns 413 for token and revoke, retaining small protocol behavior", async () => {
    for (const path of ["/oauth/token", "/oauth/revoke"]) {
      const res = await SELF.fetch(`https://pimwell.test${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "x".repeat(MAX_OAUTH_TOKEN_BODY_BYTES + 1) });
      expect(res.status).toBe(413);
    }
    expect((await tokenRequest({ grant_type: "password" })).status).toBe(400);
  });
});

describe("browser login actual-byte form ingress", () => {
  it.each(["application/x-www-form-urlencoded", "multipart/form-data; boundary=bound"])("bounds %s before links or sends", async (contentType) => {
    const h = await member();
    await grantConsent(env.HUB_DB, { email: h.identity.email, kind: "inbound_email", source_message_id: null, evidence: null }, Date.now());
    const s = streamed("/login", `email=${h.identity.email}&x=` + "x".repeat(MAX_AUTH_FORM_BODY_BYTES), { origin: "https://pimwell.test", "content-length": "1", "content-type": contentType });
    const res = await loginPostPage(s.request, env);
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("request body exceeds");
    expect(sent).toHaveLength(0);
    expect(await env.HUB_DB.prepare("SELECT 1 FROM auth_link").first()).toBeNull();
    expect(s.stats().cancelled).toBe(1);
    expect(s.request.body!.locked).toBe(false);
  });

  it("accepts exactly the auth form byte cap, and bounds UTF-8 bytes", async () => {
    const base = "email=nobody%40example.com&x=";
    expect((await loginPostPage(streamed("/login", base + "x".repeat(MAX_AUTH_FORM_BODY_BYTES - base.length), { origin: "https://pimwell.test" }).request, env)).status).toBe(200);
    expect((await loginPostPage(streamed("/login", "é".repeat(MAX_AUTH_FORM_BODY_BYTES / 2 + 1), { origin: "https://pimwell.test" }).request, env)).status).toBe(413);
    expect(sent).toHaveLength(0);
  });

  it("pre-read rate denial is independent of email membership and sends no mail", async () => {
    const ip = "198.51.100.212", now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await denyRate("login_form_ip", ip, now);
    const s = streamed("/login", "email=ann%40example.com", { origin: "https://pimwell.test", "cf-connecting-ip": ip });
    const res = await loginPostPage(s.request, env);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(s.stats().pulls).toBe(0);
    expect(s.request.bodyUsed).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("Origin denial precedes ingress quota and reading", async () => {
    const s = streamed("/login", "x".repeat(MAX_AUTH_FORM_BODY_BYTES + 1), { origin: "https://evil.example" });
    expect((await loginPostPage(s.request, env)).status).toBe(403);
    expect(s.stats().pulls).toBe(0);
    expect((await env.RATE.list({ prefix: "rl:login_form_ip:" })).keys).toHaveLength(0);
  });

  it("maps body abort/errors to inert 400 pages instead of issuing a link", async () => {
    const ac = new AbortController(); ac.abort();
    const req = new Request("https://pimwell.test/login", { method: "POST", headers: { origin: "https://pimwell.test" }, signal: ac.signal, body: "email=ann%40example.com" });
    expect((await loginPostPage(req, env)).status).toBe(400);
    const bad = new Request("https://pimwell.test/login", { method: "POST", headers: { origin: "https://pimwell.test" }, body: new ReadableStream({ start(c) { c.error(new Error("<script>private</script>")); } }) });
    const res = await loginPostPage(bad, env);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("<script>private");
    expect(sent).toHaveLength(0);
  });

  it("production entry preserves multipart login and refuses oversized forms", async () => {
    const data = new FormData(); data.set("email", "nobody@example.com");
    expect((await SELF.fetch("https://pimwell.test/login", { method: "POST", headers: { origin: "https://pimwell.test" }, body: data })).status).toBe(200);
    data.set("padding", "x".repeat(MAX_AUTH_FORM_BODY_BYTES));
    expect((await SELF.fetch("https://pimwell.test/login", { method: "POST", headers: { origin: "https://pimwell.test" }, body: data })).status).toBe(413);
    expect(sent).toHaveLength(0);
  });
});

describe("browser consent actual-byte form ingress", () => {
  it.each(["approve", "deny"])("overflow cannot %s or consume the pending request", async (decision) => {
    const { h, id, form_token } = await viewed();
    const before = await env.OAUTH_KV.get(`pending:${id}`);
    const text = new URLSearchParams({ form_token, decision }).toString() + "&x=" + "x".repeat(MAX_AUTH_FORM_BODY_BYTES);
    const s = streamed(`/oauth/consent/${id}`, text, { ...cookieHeaders(h.token, "pimwell.test"), "content-length": "1" });
    expect((await consentPost(s.request, env)).status).toBe(413);
    expect(await env.OAUTH_KV.get(`pending:${id}`)).toBe(before);
    expect(await grant()).toBeNull();
    expect(await env.HUB_DB.prepare("SELECT 1 FROM event WHERE kind IN ('oauth.grant.approve', 'oauth.grant.deny')").first()).toBeNull();
    expect(s.stats().cancelled).toBe(1);
    expect((await decide(id, h.token, form_token, decision)).status).toBe(302);
  });

  it("accepts exactly the consent byte cap and preserves required form token", async () => {
    const { h, id, form_token } = await viewed();
    const base = new URLSearchParams({ form_token, decision: "approve" }).toString() + "&x=";
    const s = streamed(`/oauth/consent/${id}`, base + "x".repeat(MAX_AUTH_FORM_BODY_BYTES - base.length), cookieHeaders(h.token, "pimwell.test"));
    expect((await consentPost(s.request, env)).status).toBe(302);
    expect(await grant()).not.toBeNull();
  });

  it("auth, Origin and invalid pending-id denial precede body reads", async () => {
    const { h, id } = await viewed();
    for (const [path, headers, status] of [
      [`/oauth/consent/${id}`, { origin: "https://pimwell.test" }, 200],
      [`/oauth/consent/${id}`, { ...cookieHeaders(h.token, "pimwell.test"), origin: "https://evil.example" }, 403],
      ["/oauth/consent/invalid", cookieHeaders(h.token, "pimwell.test"), 200],
    ] as const) {
      const s = streamed(path, "x".repeat(MAX_AUTH_FORM_BODY_BYTES + 1), headers);
      expect((await consentPost(s.request, env)).status).toBe(status);
      expect(s.stats().pulls).toBe(0);
      expect(s.request.bodyUsed).toBe(false);
    }
    expect(await grant()).toBeNull();
  });

  it("actual entry refuses multipart overflow without granting consent", async () => {
    const { h, id, form_token } = await viewed();
    const data = new FormData(); data.set("form_token", form_token); data.set("decision", "approve"); data.set("padding", "x".repeat(MAX_AUTH_FORM_BODY_BYTES));
    expect((await SELF.fetch(`https://pimwell.test/oauth/consent/${id}`, { method: "POST", headers: cookieHeaders(h.token, "pimwell.test"), body: data })).status).toBe(413);
    expect(await grant()).toBeNull();
  });
});
