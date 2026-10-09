import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_REQUEST_BODY_READ_MS, MAX_VOICE_RECORDING_READ_MS, readRequestBytes, readRequestForm } from "../src/http/body";

const enc = new TextEncoder();
const clock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
const request = (body: ReadableStream<Uint8Array>, signal?: AbortSignal) => new Request("https://pimwell.test/api/whoami", { method: "POST", body, signal });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("whole request-body read deadline", () => {
  it.each(["empty", "partial", "complete-no-eof"])('bounds %s streams despite stalled cancellation', async kind => {
    clock();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ start(c) { if (kind !== "empty") c.enqueue(enc.encode(kind === "partial" ? "{" : "{}")); }, cancel });
    const req = request(body);
    let settled = false;
    const result = readRequestBytes(req, 100).catch(e => { settled = true; return e; });
    await vi.advanceTimersByTimeAsync(MAX_REQUEST_BODY_READ_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ status: 408, reason: "request_timeout", detail: "request body read timed out" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses one budget across chunks rather than an inactivity timeout", async () => {
    clock();
    let c!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { c = controller; } });
    const result = readRequestBytes(request(body), 100).catch(e => e);
    for (let n = 0; n < 4; n++) { await vi.advanceTimersByTimeAsync(2000); c.enqueue(enc.encode("x")); await vi.advanceTimersByTimeAsync(0); }
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toMatchObject({ status: 408 });
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["eof", "chunk", "empty-chunk"])("rejects overdue %s even before timer dispatch", async kind => {
    clock();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const body = new ReadableStream<Uint8Array>({ pull(c) {
      now = MAX_REQUEST_BODY_READ_MS;
      if (kind === "eof") c.close(); else c.enqueue(kind === "chunk" ? enc.encode("{}") : new Uint8Array());
    } }, { highWaterMark: 0 });
    await expect(readRequestBytes(request(body), 100)).rejects.toMatchObject({ status: 408 });
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("checks continuously fulfilled reads without waiting for a timer", async () => {
    clock();
    let now = 0, pulls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; now += 2500; c.enqueue(enc.encode("x")); } }, { highWaterMark: 0 });
    await expect(readRequestBytes(request(body), 100)).rejects.toMatchObject({ status: 408 });
    expect(pulls).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects buffer assembly finishing at the deadline", async () => {
    clock();
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(MAX_REQUEST_BODY_READ_MS);
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode("{}")); c.close(); } });
    await expect(readRequestBytes(request(body), 100)).rejects.toMatchObject({ status: 408 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([MAX_REQUEST_BODY_READ_MS, MAX_VOICE_RECORDING_READ_MS])("accepts observed bytes just inside the %i ms budget and clears cleanup", async budget => {
    clock();
    const cancel = vi.fn();
    let c!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { c = controller; }, cancel });
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    const result = readRequestBytes(request(body), 100, budget);
    await vi.advanceTimersByTimeAsync(budget - 1);
    c.enqueue(enc.encode("é😀")); c.close();
    expect(await result).toEqual(enc.encode("é😀"));
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).not.toHaveBeenCalled();
  });
  it("propagates a form timeout rather than returning an empty neutral form", async () => {
    clock();
    const req = request(new ReadableStream());
    const result = readRequestForm(req, 100).catch(e => e);
    await vi.advanceTimersByTimeAsync(MAX_REQUEST_BODY_READ_MS);
    expect(await result).toMatchObject({ status: 408 });
  });
  it("consumes cancellation errors, rejects late data and removes listeners", async () => {
    clock();
    let c!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(async () => { throw new Error("private cancellation diagnostic"); });
    const body = new ReadableStream<Uint8Array>({ start(controller) { c = controller; }, cancel });
    const req = request(body);
    const remove = vi.spyOn(req.signal, "removeEventListener");
    const result = readRequestBytes(req, 100).catch(e => e);
    await vi.advanceTimersByTimeAsync(MAX_REQUEST_BODY_READ_MS);
    expect(await result).toMatchObject({ status: 408, detail: "request body read timed out" });
    expect(() => c.enqueue(enc.encode("{}"))).toThrow();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["abort", "overflow", "source-error"])("cleans deadline on %s without converting existing refusal", async kind => {
    clock();
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start(c) {
      if (kind === "overflow") c.enqueue(enc.encode("overflow"));
      if (kind === "source-error") c.error(new Error("private diagnostic"));
    } });
    const result = readRequestBytes(request(body, ac.signal), 2).catch(e => e);
    if (kind === "abort") ac.abort();
    expect(await result).toMatchObject({ status: kind === "overflow" ? 413 : 400 });
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects invalid durations without reading", async () => {
    for (const ms of [0, -1, NaN, Infinity, 0.5]) {
      const req = request(new ReadableStream());
      await expect(readRequestBytes(req, 100, ms)).rejects.toBeInstanceOf(RangeError);
      expect(req.bodyUsed).toBe(false);
    }
  });
});
