import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { voiceCorrect, voiceTranscribe } from "../src/http/voice";
import { MAX_VOICE_AUDIO_BYTES, MAX_VOICE_RECORDING_BODY_BYTES, MAX_VOICE_CORRECTION_BODY_BYTES } from "../src/http/body";
import { setModelFetchForTest } from "../src/models/providers";
import { addCredential } from "../src/models/store";
import { RATE_RULES } from "../src/rate";
import { sha256Hex } from "../src/ids";
import { cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test", enc = new TextEncoder();
afterEach(() => setModelFetchForTest(null));
const routes = [
  { name: "recording", path: "/voice/transcribe", limit: MAX_VOICE_RECORDING_BODY_BYTES, type: "multipart/form-data; boundary=voice-boundary", run: voiceTranscribe },
  { name: "correction", path: "/voice/correct", limit: MAX_VOICE_CORRECTION_BODY_BYTES, type: "application/json", run: voiceCorrect },
];
function recording(audio = 32, padding = 0) {
  const start = enc.encode('--voice-boundary\r\nContent-Disposition: form-data; name="audio"; filename="speech"\r\nContent-Type: audio/webm\r\n\r\n');
  const tail = enc.encode('\r\n--voice-boundary\r\nContent-Disposition: form-data; name="context"\r\n\r\nSkyLedger\r\n--voice-boundary\r\nContent-Disposition: form-data; name="ignored"\r\n\r\n' + 'x'.repeat(padding) + '\r\n--voice-boundary--\r\n');
  const bytes = new Uint8Array(start.length + audio + tail.length);
  bytes.set(start); bytes.set(tail, start.length + audio);
  return bytes;
}
function streamed(route: typeof routes[number], token: string, bytes: Uint8Array, extra: Record<string, string> = {}, signal?: AbortSignal) {
  let offset = 0, pulls = 0, cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      pulls++;
      if (offset === bytes.length) { c.close(); return; }
      const end = Math.min(offset + 64 * 1024, bytes.length);
      c.enqueue(bytes.subarray(offset, end)); offset = end;
    },
    cancel() { cancelled++; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  const request = new Request(`https://${HOST}${route.path}`, { method: "POST", signal, body: stream, headers: {
    ...cookieHeaders(token, HOST), "x-pimwell-voice": "1", "content-type": route.type, ...extra,
  } });
  return { request, stats: () => ({ pulls, cancelled }) };
}
async function world() {
  const t = await seedTenant("acme");
  const h = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  let calls = 0, audioSize = 0, input = "";
  setModelFetchForTest(async (url, init) => {
    if (String(url).endsWith("/v1/models")) return Response.json({ data: [{ id: "gpt-4o-transcribe" }] });
    calls++;
    if (String(url).endsWith("/v1/audio/transcriptions")) {
      audioSize = ((init!.body as FormData).get("file") as File).size;
      return Response.json({ text: "SkyLedger shipped", usage: { input_tokens: 1, output_tokens: 1 } });
    }
    input = (JSON.parse(String(init!.body)) as { input: string }).input;
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "corrected" }] }], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  await addCredential(env.HUB_DB, env.HUB_SECRETS_KEY, { provider: "openai", label: "test", secret: "sk-testAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaaa", tenant_id: null, created_by: null }, Date.now());
  const effects = async () => ({
    calls,
    ledger: (await env.HUB_DB.prepare("SELECT * FROM model_call").all()).results,
    messages: (await env.HUB_DB.prepare("SELECT * FROM assistant_message").all()).results,
    events: (await env.HUB_DB.prepare("SELECT * FROM event").all()).results,
  });
  return { h, t, effects, seen: () => ({ audioSize, input }) };
}
const overflow = (route: typeof routes[number]) => new Uint8Array(route.limit + 1);

describe("voice actual-byte ingress", () => {
  it.each(routes)("bounds $name before parsing even with forged framing and stalled cancellation", async (route) => {
    const w = await world(), before = await w.effects();
    const s = streamed(route, w.h.token, overflow(route), { "content-length": "1", "transfer-encoding": "chunked" });
    const res = await route.run(s.request, env);
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(s.stats().cancelled).toBe(1);
    expect(s.request.body!.locked).toBe(false);
    expect(await w.effects()).toEqual(before);
  });
  it.each(routes)("$name counts UTF-8 with absent, zero and malformed length", async (route) => {
    const w = await world(), before = await w.effects();
    const bytes = enc.encode("界".repeat(Math.floor(route.limit / 3) + 1));
    for (const extra of [{}, { "content-length": "0" }, { "content-length": "bad" }] as Record<string, string>[]) {
      const s = streamed(route, w.h.token, bytes, extra);
      expect((await route.run(s.request, env)).status).toBe(413);
      expect(s.stats().cancelled).toBe(1);
    }
    expect(await w.effects()).toEqual(before);
  });
  it.each(routes)("$name rejects declared oversize without pulling", async (route) => {
    const w = await world();
    const s = streamed(route, w.h.token, enc.encode("small"), { "content-length": String(route.limit + 1) });
    expect((await route.run(s.request, env)).status).toBe(413);
    expect(s.stats()).toEqual({ pulls: 0, cancelled: 1 });
  });
  it.each(routes)("$name browser/tenant/Origin/header gates precede body reads", async (route) => {
    const w = await world(), before = await w.effects();
    const outsider = await seedHuman("outside@example.com");
    for (const [extra, status] of [
      [{ cookie: "pmw_session=invalid" }, 404],
      [{ cookie: "", authorization: `Bearer ${w.h.token}` }, 404],
      [{ ...cookieHeaders(outsider.token, HOST) }, 404],
      [{ origin: "https://evil.example" }, 403],
      [{ "x-pimwell-voice": "" }, 403],
    ] as [Record<string, string>, number][]) {
      const s = streamed(route, w.h.token, enc.encode("ignored"), { "content-length": String(route.limit + 1), ...extra });
      expect((await route.run(s.request, env)).status).toBe(status);
      expect(s.stats().pulls).toBe(0);
      expect(s.request.bodyUsed).toBe(false);
    }
    expect(await w.effects()).toEqual(before);
  });
  it.each(routes)("$name rate denial precedes body reads", async (route) => {
    const w = await world();
    const rule = RATE_RULES.voice_identity;
    await env.RATE.put(`rl:voice_identity:${Math.floor(Date.now() / rule.windowMs)}:${await sha256Hex(w.h.identity.id.toLowerCase())}`, String(rule.limit));
    const s = streamed(route, w.h.token, enc.encode("ignored"), { "content-length": String(route.limit + 1) });
    expect((await route.run(s.request, env)).status).toBe(429);
    expect(s.stats().pulls).toBe(0);
  });
  it.each(routes)("$name handles read errors and aborts safely without effects", async (route) => {
    const w = await world(), before = await w.effects();
    const source = streamed(route, w.h.token, enc.encode("small")).request;
    const errorRequest = new Request(source.url, { method: "POST", headers: source.headers, body: new ReadableStream({ pull(c) { c.error(new Error("private-stream-secret")); } }) });
    const res = await route.run(errorRequest, env);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("private-stream-secret");
    const controller = new AbortController(); controller.abort();
    const s = streamed(route, w.h.token, enc.encode("small"), {}, controller.signal);
    expect((await route.run(s.request, env)).status).toBe(400);
    expect(s.stats().pulls).toBe(0);
    expect(s.request.body!.locked).toBe(false);
    expect(await w.effects()).toEqual(before);
  });
  it.each(routes)("the production entry bounds $name without effects", async (route) => {
    const w = await world(), before = await w.effects();
    expect((await SELF.fetch(streamed(route, w.h.token, overflow(route)).request)).status).toBe(413);
    expect(await w.effects()).toEqual(before);
  });
  it("accepts a full 15 MiB audio file at the exact envelope cap with forged framing", async () => {
    const w = await world(), route = routes[0]!;
    const framing = recording(MAX_VOICE_AUDIO_BYTES).length - MAX_VOICE_AUDIO_BYTES;
    const bytes = recording(MAX_VOICE_AUDIO_BYTES, route.limit - MAX_VOICE_AUDIO_BYTES - framing);
    expect(bytes.length).toBe(route.limit);
    const s = streamed(route, w.h.token, bytes, { "content-length": "0", "transfer-encoding": "chunked" });
    const res = await voiceTranscribe(s.request, env);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ text: "SkyLedger shipped" });
    expect(w.seen().audioSize).toBe(MAX_VOICE_AUDIO_BYTES);
    expect(s.stats().cancelled).toBe(0);
    expect(s.request.body!.locked).toBe(false);
    expect((await w.effects()).ledger).toHaveLength(1);
  });
  it("retains the audio file limit inside an otherwise bounded multipart envelope", async () => {
    const w = await world(), before = await w.effects();
    const bytes = recording(MAX_VOICE_AUDIO_BYTES + 1);
    expect(bytes.length).toBeLessThan(MAX_VOICE_RECORDING_BODY_BYTES);
    expect((await voiceTranscribe(streamed(routes[0]!, w.h.token, bytes).request, env)).status).toBe(413);
    expect(await w.effects()).toEqual(before);
  });
  it("counts ignored multipart fields, not just the audio file", async () => {
    const w = await world(), before = await w.effects();
    const bytes = recording(32, MAX_VOICE_RECORDING_BODY_BYTES);
    expect((await voiceTranscribe(streamed(routes[0]!, w.h.token, bytes).request, env)).status).toBe(413);
    expect(await w.effects()).toEqual(before);
  });
  it("keeps decoded correction limits while accepting a full Unicode transcript/envelope", async () => {
    const w = await world(), route = routes[1]!, before = await w.effects();
    const base = JSON.stringify({ text: "界".repeat(10000), context: "界".repeat(4800), ignored: "界".repeat(20000) });
    const raw = base + " ".repeat(40000 - base.length);
    expect(enc.encode(raw).length).toBeGreaterThan(100000);
    expect((await voiceCorrect(streamed(route, w.h.token, enc.encode(raw + " ")).request, env)).status).toBe(413);
    expect((await voiceCorrect(streamed(route, w.h.token, enc.encode(JSON.stringify({ text: "x".repeat(10001) }))).request, env)).status).toBe(400);
    expect(await w.effects()).toEqual(before);
    const res = await voiceCorrect(streamed(route, w.h.token, enc.encode(raw), { "content-length": "1" }).request, env);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ text: "界".repeat(10000), changed: false });
    expect(w.seen().input).toContain("界".repeat(10000));
    expect((await w.effects()).ledger).toHaveLength(1);
  });
  it("reads exactly the correction byte cap but still refuses the decoded envelope", async () => {
    const w = await world(), before = await w.effects();
    const s = streamed(routes[1]!, w.h.token, enc.encode(" ".repeat(MAX_VOICE_CORRECTION_BODY_BYTES)));
    expect((await voiceCorrect(s.request, env)).status).toBe(413);
    expect(s.stats().cancelled).toBe(0);
    expect(s.request.body!.locked).toBe(false);
    expect(await w.effects()).toEqual(before);
  });
  it("refuses malformed correction JSON/objects and media before model effects", async () => {
    const w = await world(), before = await w.effects();
    for (const raw of ["{bad", "null", "[]", "true", "1", '"text"', "{}", '{"text":123}']) {
      expect((await voiceCorrect(streamed(routes[1]!, w.h.token, enc.encode(raw)).request, env)).status).toBe(400);
    }
    const s = streamed(routes[1]!, w.h.token, enc.encode("ignored"), { "content-type": "text/plain" });
    expect((await voiceCorrect(s.request, env)).status).toBe(400);
    expect(s.stats().pulls).toBe(0);
    expect(await w.effects()).toEqual(before);
  });
  it("refuses malformed multipart and missing recording without effects", async () => {
    const w = await world(), before = await w.effects();
    for (const bytes of [enc.encode("{bad"), recording(0)]) {
      expect((await voiceTranscribe(streamed(routes[0]!, w.h.token, bytes).request, env)).status).toBe(400);
    }
    expect(await w.effects()).toEqual(before);
  });
});
