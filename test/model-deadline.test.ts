import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provider, setModelFetchForTest, MAX_MODEL_RESPONSE_BYTES } from "../src/models/providers";
import { MODEL_CALL_TIMEOUT_MS, ModelCallCancelled, ModelCallTimeout } from "../src/models/deadline";
import { addCredential } from "../src/models/store";
import { ask } from "../src/models/ask";

const p = provider("openai")!;
const key = "sk-testAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaaa";
const clock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
const invoke = (method: string, signal?: AbortSignal) => {
  if (method === "verify") return p.verify(key, { signal });
  if (method === "turn") return p.turn(key, "test", [], { instructions: "test", tools: [], signal });
  if (method === "transcribe") return p.transcribe!(key, "test", new Blob(["test"]), "test.webm", "", { signal });
  return p.ask(key, "test", "test", { signal });
};
const success = () => Response.json({ data: [], output: [], text: "test", usage: { input_tokens: 3, output_tokens: 2 } });
afterEach(() => { setModelFetchForTest(null); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("provider whole-call deadlines", () => {
  it.each(["verify", "ask", "turn", "transcribe"])("bounds %s headers even when transport ignores abort; never retries", async method => {
    clock();
    let signal!: AbortSignal;
    let release!: (r: Response) => void;
    const fetch = vi.fn(async (_input, init) => { signal = init!.signal!; return new Promise<Response>(resolve => { release = resolve; }); });
    setModelFetchForTest(fetch);
    let settled = false;
    const result = invoke(method).catch(e => { settled = true; return e; });
    await vi.advanceTimersByTimeAsync(MODEL_CALL_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(ModelCallTimeout);
    expect(signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const cancel = vi.fn();
    release(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 401, 429, 500])("bounds stalled %i JSON, including an error body", async status => {
    clock();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel }), { status });
    setModelFetchForTest(async () => response);
    const result = invoke("ask").catch(e => e);
    await vi.advanceTimersByTimeAsync(MODEL_CALL_TIMEOUT_MS);
    expect(await result).toBeInstanceOf(ModelCallTimeout);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the same budget for headers and body and accepts just inside the boundary", async () => {
    clock();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    setModelFetchForTest(async () => {
      await new Promise(resolve => setTimeout(resolve, 20_000));
      return new Response(new ReadableStream({ start(c) { body = c; } }));
    });
    const result = invoke("ask");
    await vi.advanceTimersByTimeAsync(MODEL_CALL_TIMEOUT_MS - 1);
    body.enqueue(new TextEncoder().encode(JSON.stringify({ output: [], usage: { input_tokens: 3, output_tokens: 2 } }))); body.close();
    expect(await result).toMatchObject({ text: "", inputTokens: 3, outputTokens: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body", "error"])("rejects late %s before timer dispatch (sleep/paused clock)", async phase => {
    clock();
    let wall = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    setModelFetchForTest(async () => {
      if (phase === "headers") { wall += MODEL_CALL_TIMEOUT_MS; return success(); }
      return new Response(new ReadableStream({ pull(c) {
        wall += MODEL_CALL_TIMEOUT_MS;
        c.enqueue(new TextEncoder().encode('{"output":[]}')); c.close();
      } }, { highWaterMark: 0 }), { status: phase === "error" ? 401 : 200 });
    });
    await expect(invoke("ask")).rejects.toBeInstanceOf(ModelCallTimeout);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["before", "headers", "body"])("propagates %s cancellation and releases pending ignored-abort transport", async phase => {
    clock();
    const parent = new AbortController();
    const fetch = vi.fn(async (_input, init) => {
      expect(init!.signal).not.toBe(parent.signal);
      if (phase === "headers") { parent.abort(); return new Promise<Response>(() => {}); }
      return new Response(new ReadableStream({ pull() { parent.abort(); } }, { highWaterMark: 0 }));
    });
    setModelFetchForTest(fetch);
    if (phase === "before") parent.abort();
    await expect(invoke("ask", parent.signal)).rejects.toBeInstanceOf(ModelCallCancelled);
    expect(fetch).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not turn successful cleanup or later caller abort into failure", async () => {
    clock();
    const parent = new AbortController();
    let transport!: AbortSignal;
    setModelFetchForTest(async (_input, init) => { transport = init!.signal!; return success(); });
    await expect(invoke("ask", parent.signal)).resolves.toMatchObject({ inputTokens: 3 });
    parent.abort();
    await vi.advanceTimersByTimeAsync(MODEL_CALL_TIMEOUT_MS);
    expect(transport.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds continuously fulfilled chunks before timers dispatch", async () => {
    clock();
    let now = 0, pulls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const response = new Response(new ReadableStream({ pull(c) { now += 10_000; pulls++; c.enqueue(new TextEncoder().encode(" ")); } }, { highWaterMark: 0 }));
    setModelFetchForTest(async () => response);
    await expect(invoke("ask")).rejects.toBeInstanceOf(ModelCallTimeout);
    expect(pulls).toBe(3);
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["declared", "actual"])("bounds %s response bytes before JSON decoding", async mode => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_MODEL_RESPONSE_BYTES + 1)); }, cancel }),
      { headers: { "content-length": mode === "declared" ? String(MAX_MODEL_RESPONSE_BYTES + 1) : "1" } });
    setModelFetchForTest(async () => response);
    await expect(invoke("ask")).rejects.toThrow("model response exceeds byte limit");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
  });

  it("records one failed unknown-usage call and 504, never late success or replay", async () => {
    setModelFetchForTest(async () => Response.json({ data: [] }));
    await addCredential(env.HUB_DB, env.HUB_SECRETS_KEY, { provider: "openai", label: "fixture", secret: key, tenant_id: null, created_by: null }, Date.now());
    let wall = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    setModelFetchForTest(async () => { wall += MODEL_CALL_TIMEOUT_MS; return success(); });
    await expect(ask(env, "fast", "fixture")).rejects.toMatchObject({ status: 504, reason: "provider_timeout" });
    const calls = (await env.HUB_DB.prepare("SELECT ok, input_tokens, output_tokens, error FROM model_call").all()).results;
    expect(calls).toEqual([{ ok: 0, input_tokens: null, output_tokens: null, error: "model call timed out; delivery and usage may be unknown" }]);
    expect((await env.HUB_DB.prepare("SELECT last_error FROM provider_credential").first())!.last_error).not.toContain(key);
  });
});
