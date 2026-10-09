import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantChat } from "../src/http/assistantPages";
import { playgroundCall } from "../src/http/playground";
import { channelPost } from "../src/http/chatPages";
import { MAX_ASSISTANT_BODY_BYTES, MAX_CHANNEL_FORM_BODY_BYTES, MAX_PLAYGROUND_BODY_BYTES } from "../src/http/body";
import { setModelFetchForTest } from "../src/models/providers";
import { addCredential } from "../src/models/store";
import { RATE_RULES, type RateBucket } from "../src/rate";
import { sha256Hex } from "../src/ids";
import { createProject } from "../src/db/projects";
import { cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { HOST, ok } from "./chat-helpers";

const enc = new TextEncoder();
afterEach(() => { setModelFetchForTest(null); vi.restoreAllMocks(); });
const routes = [
  { name: "assistant", path: "/assistant/chat", limit: MAX_ASSISTANT_BODY_BYTES, type: "application/json", run: assistantChat, body: JSON.stringify({ text: "hello", scopes: "read" }) },
  { name: "playground", path: "/playground/call", limit: MAX_PLAYGROUND_BODY_BYTES, type: "application/json", run: playgroundCall, body: JSON.stringify({ tool: "whoami", arguments: {}, scopes: "read" }) },
  { name: "channel", path: "/c/general", limit: MAX_CHANNEL_FORM_BODY_BYTES, type: "application/x-www-form-urlencoded", run: (r: Request, e: typeof env) => channelPost(r, e, "general", null), body: "body=hello&after=0" },
];

function streamed(route: typeof routes[number], token: string, text: string, extra: Record<string, string> = {}, signal?: AbortSignal) {
  const bytes = enc.encode(text);
  let offset = 0, pulls = 0, cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      pulls++;
      if (offset === bytes.length) { c.close(); return; }
      const end = Math.min(offset + 1024, bytes.length);
      c.enqueue(bytes.subarray(offset, end)); offset = end;
    },
    cancel() { cancelled++; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  const request = new Request(`https://${HOST}${route.path}`, { method: "POST", signal, body: stream, headers: {
    ...cookieHeaders(token, HOST), "content-type": route.type, "x-pimwell-playground": "1", ...extra,
  } });
  return { request, stats: () => ({ pulls, cancelled }) };
}
async function world() {
  const t = await seedTenant("acme");
  const h = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  await ok(h.token, "channel.create", { slug: "general" });
  let modelCalls = 0;
  setModelFetchForTest(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "gpt-6.1-sol" }] });
    modelCalls++;
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "bounded answer" }] }], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  await addCredential(env.HUB_DB, env.HUB_SECRETS_KEY, { provider: "openai", label: "test", secret: "sk-testAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaaa", tenant_id: null, created_by: null }, Date.now());
  const effects = async () => ({
    modelCalls,
    threads: (await env.HUB_DB.prepare("SELECT * FROM assistant_thread").all()).results,
    messages: (await env.HUB_DB.prepare("SELECT * FROM assistant_message").all()).results,
    tools: (await env.HUB_DB.prepare("SELECT * FROM event WHERE kind = 'playground.call'").all()).results,
    work: (await env.HUB_DB.prepare("SELECT * FROM work_item").all()).results,
    head: (await ok(h.token, "chat.read", { c: "general" })).head,
  });
  return { t, h, effects };
}
const padded = (route: typeof routes[number], bytes: number) => route.type === "application/json"
  ? route.body + " ".repeat(bytes - enc.encode(route.body).length)
  : route.body + "&padding=" + "x".repeat(bytes - enc.encode(route.body + "&padding=").length);

// Actual Workers handlers with chunked bodies and stalled cancellation. No
// model/tool/message effects may happen before a body is bounded and parsed.
describe("browser chat actual-byte ingress", () => {
  it.each(routes)("bounds $name with understated framing before any effects", async (route) => {
    const w = await world();
    const before = await w.effects();
    const s = streamed(route, w.h.token, padded(route, route.limit + 1), { "content-length": "1", "transfer-encoding": "chunked" });
    const res = await route.run(s.request, env);
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(s.stats().cancelled).toBe(1);
    expect(s.request.body!.locked).toBe(false);
    expect(await w.effects()).toEqual(before);
  });

  it.each(routes)("$name refuses absent, zero or malformed length and counts UTF-8", async (route) => {
    const w = await world();
    const before = await w.effects();
    for (const headers of [{}, { "content-length": "0" }, { "content-length": "bad" }] as Record<string, string>[]) {
      // Fewer decoded characters than the budget, but more actual bytes.
      const s = streamed(route, w.h.token, "界".repeat(Math.floor(route.limit / 3) + 1), headers);
      expect((await route.run(s.request, env)).status).toBe(413);
      expect(s.stats().cancelled).toBe(1);
    }
    expect(await w.effects()).toEqual(before);
  });

  it.each(routes)("$name rejects a declared oversize without pulling", async (route) => {
    const w = await world();
    const s = streamed(route, w.h.token, route.body, { "content-length": String(route.limit + 1) });
    expect((await route.run(s.request, env)).status).toBe(413);
    expect(s.stats()).toEqual({ pulls: 0, cancelled: 1 });
  });

  it.each(routes)("$name auth and foreign-Origin denials precede reads", async (route) => {
    const w = await world();
    const before = await w.effects();
    for (const extra of [{ cookie: "pmw_session=invalid" }, { origin: "https://evil.example" }, { cookie: "", authorization: `Bearer ${w.h.token}` }] as Record<string, string>[]) {
      const s = streamed(route, w.h.token, "x".repeat(route.limit + 1), extra);
      const res = await route.run(s.request, env);
      expect([303, 403, 404]).toContain(res.status);
      expect(s.stats().pulls).toBe(0);
      expect(s.request.bodyUsed).toBe(false);
    }
    expect(await w.effects()).toEqual(before);
  });

  it.each(routes)("$name returns inert safe read errors and aborts", async (route) => {
    const w = await world();
    const before = await w.effects();
    const broken = streamed(route, w.h.token, route.body).request;
    const errorRequest = new Request(broken.url, { method: "POST", headers: broken.headers, body: new ReadableStream({ pull(c) { c.error(new Error("private-stream-secret")); } }) });
    const bad = await route.run(errorRequest, env);
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("private-stream-secret");
    const controller = new AbortController(); controller.abort();
    const s = streamed(route, w.h.token, route.body, {}, controller.signal);
    expect((await route.run(s.request, env)).status).toBe(400);
    expect(s.stats().pulls).toBe(0);
    expect(s.request.body!.locked).toBe(false);
    expect(await w.effects()).toEqual(before);
  });

  it.each(routes)("$name rejects malformed bounded input without effects", async (route) => {
    const w = await world();
    const before = await w.effects();
    const s = streamed(route, w.h.token, "{bad", route.name === "channel" ? { "content-type": "application/json" } : {});
    expect((await route.run(s.request, env)).status).toBe(400);
    expect(await w.effects()).toEqual(before);
  });

  it.each(routes.filter((r) => r.name !== "assistant"))("$name accepts exactly the byte cap with forged framing", async (route) => {
    const w = await world();
    const s = streamed(route, w.h.token, padded(route, route.limit), { "content-length": "0", "transfer-encoding": "chunked" });
    expect((await route.run(s.request, env)).status).toBe(route.name === "channel" ? 303 : 200);
    expect(s.stats().cancelled).toBe(0);
    expect(s.request.body!.locked).toBe(false);
  });

  it("keeps the Assistant's decoded-character and message limits; accepts a full Unicode turn", async () => {
    const w = await world();
    const route = routes[0]!;
    const before = await w.effects();
    // Body fits byte cap, but exceeds the original decoded envelope allowance.
    expect((await assistantChat(streamed(route, w.h.token, padded(route, route.limit)).request, env)).status).toBe(413);
    expect((await assistantChat(streamed(route, w.h.token, JSON.stringify({ text: "x".repeat(8001) })).request, env)).status).toBe(400);
    expect(await w.effects()).toEqual(before);
    const res = await assistantChat(streamed(route, w.h.token, JSON.stringify({ text: "界".repeat(8000) }), { "content-length": "1" }).request, env);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as { reply: string };
    expect(body.reply).toBe("bounded answer");
    expect((await w.effects()).messages).toHaveLength(2);
  });

  it("does not change an existing Assistant thread's scopes on overflow", async () => {
    const w = await world();
    const route = routes[0]!;
    const good = await assistantChat(streamed(route, w.h.token, route.body).request, env);
    const { thread } = await good.json() as { thread: string };
    const before = await w.effects();
    const text = JSON.stringify({ thread, scopes: "write", text: "hello", padding: "x".repeat(route.limit) });
    expect((await assistantChat(streamed(route, w.h.token, text).request, env)).status).toBe(413);
    expect(await w.effects()).toEqual(before);
  });

  it("does not execute a real Playground write intent on overflow", async () => {
    const w = await world();
    const before = await w.effects();
    const route = routes[1]!;
    const text = JSON.stringify({ tool: "work_create", scopes: "write", arguments: { project: "site", kind: "snag", title: "must not exist" }, padding: "x".repeat(route.limit) });
    expect((await playgroundCall(streamed(route, w.h.token, text).request, env)).status).toBe(413);
    expect(await w.effects()).toEqual(before);
  });

  it.each(routes.slice(0, 2))("$name header/media/rate denials precede reads", async (route) => {
    const w = await world();
    for (const extra of [{ "x-pimwell-playground": "" }, { "content-type": "text/plain" }] as Record<string, string>[]) {
      const s = streamed(route, w.h.token, "x".repeat(route.limit + 1), extra);
      expect((await route.run(s.request, env)).status).toBe(403);
      expect(s.stats().pulls).toBe(0);
    }
    const bucket: RateBucket = route.name === "assistant" ? "assistant_turn" : "playground_session";
    const rule = RATE_RULES[bucket];
    const subject = route.name === "assistant" ? w.h.identity.id : w.h.session.id;
    await env.RATE.put(`rl:${bucket}:${Math.floor(Date.now() / rule.windowMs)}:${await sha256Hex(subject.toLowerCase())}`, String(rule.limit));
    const s = streamed(route, w.h.token, "x".repeat(route.limit + 1));
    expect((await route.run(s.request, env)).status).toBe(429);
    expect(s.stats().pulls).toBe(0);
  });

  it("denies a reader before channel-form parsing", async () => {
    const w = await world();
    const h = await seedHuman("reader@example.com", { memberships: [{ tenant_id: w.t.id, role: "reader" }] });
    const s = streamed(routes[2]!, h.token, "x".repeat(MAX_CHANNEL_FORM_BODY_BYTES + 1));
    expect((await channelPost(s.request, env, "general", null)).status).toBe(403);
    expect(s.stats().pulls).toBe(0);
  });

  it("bounds thread reply forms without posting or moving the head", async () => {
    const w = await world();
    const root = await ok(w.h.token, "chat.post", { c: "general", body: "root" });
    const before = await w.effects();
    const s = streamed(routes[2]!, w.h.token, `body=reply&after=${root.head}&padding=${"x".repeat(MAX_CHANNEL_FORM_BODY_BYTES)}`);
    expect((await channelPost(s.request, env, "general", String(root.seq))).status).toBe(413);
    expect(await w.effects()).toEqual(before);
  });

  it("accepts a full URL-encoded Unicode channel draft and counts multipart framing", async () => {
    const w = await world();
    const route = routes[2]!;
    const draft = "界".repeat(2730) + "xx";
    expect(enc.encode(draft).length).toBe(8192);
    const text = new URLSearchParams({ body: draft, after: "0" }).toString();
    expect(enc.encode(text).length).toBeGreaterThan(24 * 1024 - 10);
    expect((await channelPost(streamed(route, w.h.token, text).request, env, "general", null)).status).toBe(303);
    const before = await w.effects();
    const form = new FormData(); form.set("body", "must not post"); form.set("after", "1"); form.set("padding", "x".repeat(route.limit));
    const request = new Request(`https://${HOST}/c/general`, { method: "POST", headers: cookieHeaders(w.h.token, HOST), body: form });
    expect((await channelPost(request, env, "general", null)).status).toBe(413);
    expect(await w.effects()).toEqual(before);
  });

  it.each(routes)("the production entry bounds $name", async (route) => {
    const w = await world();
    const before = await w.effects();
    const request = streamed(route, w.h.token, padded(route, route.limit + 1)).request;
    expect((await SELF.fetch(request)).status).toBe(413);
    expect(await w.effects()).toEqual(before);
  });
});
