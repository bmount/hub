import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { MAX_REQUEST_BODY_READ_MS, MAX_VOICE_RECORDING_READ_MS } from "../src/http/body";
import { setTestTransport } from "../src/mail/send";
import { setModelFetchForTest } from "../src/models/providers";
import { cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { authorize, connectWithTokens, formTokenOf, pendingIdOf, pkce, registerClient, viewConsent } from "./oauth-helpers";

const enc = new TextEncoder();
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); setTestTransport(null); setModelFetchForTest(null); });
const routes = [
  ["api-json", "https://pimwell.test/api/whoami", "application/json"],
  ["api-form", "https://pimwell.test/api/whoami", "application/x-www-form-urlencoded"],
  ["register", "https://pimwell.test/oauth/register", "application/json"],
  ["token", "https://pimwell.test/oauth/token", "application/x-www-form-urlencoded"],
  ["revoke", "https://pimwell.test/oauth/revoke", "application/x-www-form-urlencoded"],
  ["login", "https://pimwell.test/login", "application/x-www-form-urlencoded"],
  ["assistant", "https://acme.pimwell.test/assistant/chat", "application/json"],
  ["playground", "https://acme.pimwell.test/playground/call", "application/json"],
  ["channel", "https://acme.pimwell.test/c/general", "application/x-www-form-urlencoded"],
  ["introspect", "https://pimwell.test/internal/introspect", "application/json"],
  ["backlinks", "https://pimwell.test/internal/backlinks", "application/json"],
  ["eval", "https://pimwell.test/internal/evals/intent", "application/json"],
  ["voice-recording", "https://acme.pimwell.test/voice/transcribe", "multipart/form-data; boundary=test"],
  ["voice-correction", "https://acme.pimwell.test/voice/correct", "application/json"],
  ["mcp", "https://acme.pimwell.test/mcp", "application/json"],
  ["consent", "https://pimwell.test/oauth/consent/placeholder", "application/x-www-form-urlencoded"],
] as const;
async function setup(kind: string, url: string, type: string) {
  const tenant = await seedTenant("acme");
  const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: tenant.id, role: "admin" }] });
  let body = type === "application/json" ? "{}" : "email=ann%40example.com";
  const headers: Record<string, string> = { ...cookieHeaders(h.token, new URL(url).host), "content-type": type,
    "x-pimwell-playground": "1", "x-pimwell-voice": "1", "content-length": "1" };
  if (kind === "introspect" || kind === "backlinks") headers["x-hub-internal"] = "test-internal-secret";
  if (kind === "eval") headers.authorization = "Bearer test-eval-key";
  if (kind === "mcp" || kind === "token" || kind === "revoke") {
    const c = await connectWithTokens(h.token);
    if (kind === "mcp") {
      delete headers.origin;
      delete headers.cookie;
      headers.authorization = `Bearer ${c.tokens.access_token}`;
      headers.accept = "application/json, text/event-stream";
      headers["mcp-protocol-version"] = "2025-06-18";
      body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    } else body = new URLSearchParams({ client_id: c.client_id, token: c.tokens.refresh_token,
      refresh_token: c.tokens.refresh_token, ...(kind === "token" ? { grant_type: "refresh_token" } : {}) }).toString();
  }
  if (kind === "consent") {
    const client_id = await registerClient(), { challenge } = await pkce();
    const id = pendingIdOf(await authorize({ client_id, challenge }));
    const form_token = formTokenOf(await (await viewConsent(id, h.token)).text());
    url = `https://pimwell.test/oauth/consent/${id}`;
    body = new URLSearchParams({ form_token, decision: "allow", tenant: "acme", scopes: "read" }).toString();
  }
  let sent = 0, models = 0;
  setTestTransport(async () => { sent++; });
  setModelFetchForTest(async () => { models++; throw new Error("unexpected model invocation"); });
  const effects = async () => ({ sent, models,
    grants: (await env.HUB_DB.prepare("SELECT * FROM oauth_grant").all()).results,
    pending: await Promise.all((await env.OAUTH_KV.list({ prefix: "pending:" })).keys.map(async k => [k.name, await env.OAUTH_KV.get(k.name)])),
    threads: (await env.HUB_DB.prepare("SELECT * FROM assistant_thread").all()).results,
    messages: (await env.HUB_DB.prepare("SELECT * FROM assistant_message").all()).results,
    work: (await env.HUB_DB.prepare("SELECT * FROM work_item").all()).results,
    calls: (await env.HUB_DB.prepare("SELECT * FROM model_call").all()).results,
    events: (await env.HUB_DB.prepare("SELECT * FROM event WHERE kind IN ('mcp.call', 'playground.call', 'eval.run', 'oauth.grant.revoke', 'oauth.consent', 'oauth.client.register')").all()).results,
  });
  return { url, headers, body, effects };
}

describe("production request routing respects whole-body deadlines", () => {
  it.each(routes)("%s refuses late original bytes before parsing/effects", async (kind, url, type) => {
    const w = await setup(kind, url, type), before = await w.effects();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const budget = kind === "voice-recording" ? MAX_VOICE_RECORDING_READ_MS : MAX_REQUEST_BODY_READ_MS;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ pull(c) { now += budget; c.enqueue(enc.encode(w.body)); }, cancel }, { highWaterMark: 0 });
    const req = new Request(w.url, { method: "POST", headers: w.headers, body });
    const res = await worker.fetch(req, env, createExecutionContext());
    expect(res.status, await res.clone().text()).toBe(408);
    expect(await res.text()).not.toContain(w.body);
    expect(req.body!.locked).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await w.effects()).toEqual(before);
  });
  it.each([routes[0], routes[12], routes[14]])("%s bounds a pending original read even if cancel never settles", async (kind, url, type) => {
    const w = await setup(kind, url, type), before = await w.effects();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let pulled!: () => void;
    const reading = new Promise<void>(r => { pulled = r; });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ pull() { pulled(); return new Promise<void>(() => {}); }, cancel }, { highWaterMark: 0 });
    const req = new Request(w.url, { method: "POST", headers: w.headers, body });
    const result = Promise.resolve(worker.fetch(req, env, createExecutionContext()));
    await Promise.race([reading, result.then(r => { throw new Error(`refused before read: ${r.status}`); })]);
    const budget = kind === "voice-recording" ? MAX_VOICE_RECORDING_READ_MS : MAX_REQUEST_BODY_READ_MS;
    await vi.advanceTimersByTimeAsync(budget);
    const res = await result;
    expect(res.status).toBe(408);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(req.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    expect(await w.effects()).toEqual(before);
  });
  it("production auth refusal does not read or establish a deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const pull = vi.fn();
    const req = new Request("https://acme.pimwell.test/voice/transcribe", { method: "POST", body: new ReadableStream({ pull }, { highWaterMark: 0 }) });
    expect((await worker.fetch(req, env, createExecutionContext())).status).toBe(404);
    expect(pull).not.toHaveBeenCalled();
    expect(req.bodyUsed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
