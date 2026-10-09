import { afterEach, describe, expect, it, vi } from "vitest";
import { readOriginalMail, MAX_RAW_MAIL_BYTES, MAX_RAW_MAIL_READ_MS } from "../src/mail/raw";
import { verifyIndependentDkim } from "../src/mail/dkim";
import fixtures from "./fixtures/dkim.json";

const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
const encode = (s: string) => new TextEncoder().encode(s);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("original ingress whole-read deadline", () => {
  it.each([false, true])("bounds an empty stalled stream even when cancellation stalls (%s)", async stalls => {
    fakeClock();
    const cancel = vi.fn(() => stalls ? new Promise<void>(() => {}) : undefined);
    const stream = new ReadableStream<Uint8Array>({ cancel });
    let settled = false;
    const result = readOriginalMail(stream).catch(e => { settled = true; return e.message; });
    await vi.advanceTimersByTimeAsync(MAX_RAW_MAIL_READ_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("mail read aborted");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cannot authenticate a complete signed message whose stream never reaches EOF", async () => {
    fakeClock();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encode(fixtures.valid)); }, cancel });
    const result = readOriginalMail(stream).catch(e => e.message);
    await vi.advanceTimersByTimeAsync(MAX_RAW_MAIL_READ_MS);
    expect(await result).toBe("mail read aborted");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses one budget for all chunks, not a fresh budget per read", async () => {
    fakeClock();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel });
    const result = readOriginalMail(stream).catch(e => e.message);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      controller.enqueue(new Uint8Array([i]));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe("mail read aborted");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["eof", "chunk"])("refuses overdue %s before the timer callback gets dispatched", async late => {
    fakeClock();
    let monotonic = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ pull(c) {
      monotonic = MAX_RAW_MAIL_READ_MS;
      if (late === "eof") c.close(); else c.enqueue(encode(fixtures.valid));
    }, cancel }, { highWaterMark: 0 });
    await expect(readOriginalMail(stream)).rejects.toThrow("mail read deadline");
    expect(cancel).toHaveBeenCalledTimes(late === "eof" ? 0 : 1);
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks continuous immediately fulfilled chunk loops without waiting for timers", async () => {
    fakeClock();
    let monotonic = 0, pulls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull(c) {
      pulls++;
      monotonic += 2500;
      c.enqueue(new Uint8Array([pulls]));
    }, cancel }, { highWaterMark: 0 });
    await expect(readOriginalMail(stream)).rejects.toThrow("mail read deadline");
    expect(pulls).toBe(4);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["valid", "ed25519"] as const)("preserves %s signed bytes completing just inside the deadline", async kind => {
    fakeClock();
    const original = encode(fixtures[kind]);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel });
    const result = readOriginalMail(stream);
    await vi.advanceTimersByTimeAsync(MAX_RAW_MAIL_READ_MS - 1);
    controller.enqueue(original); controller.close();
    expect(await result).toEqual(original);
    expect(stream.locked).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const record = kind === "valid" ? fixtures.record : fixtures.edRecord;
    expect((await verifyIndependentDkim(await result, "member@example.com", Date.parse(fixtures.now) + 120_000,
      async () => [[record]])).authentication).toBe("pass");
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("refuses byte assembly that finishes after the monotonic deadline", async () => {
    fakeClock();
    vi.spyOn(performance, "now").mockReturnValueOnce(0) // budget start
      .mockReturnValueOnce(0) // initial check
      .mockReturnValueOnce(0) // chunk
      .mockReturnValueOnce(0) // EOF
      .mockReturnValue(MAX_RAW_MAIL_READ_MS); // assembled result
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encode(fixtures.valid)); c.close(); } });
    await expect(readOriginalMail(stream)).rejects.toThrow("mail read deadline");
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes a rejected cancellation without waiting or leaking its private diagnostic", async () => {
    fakeClock();
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    const cancel = vi.fn(async () => { throw new Error("private cancellation failure"); });
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const result = readOriginalMail(stream).catch(e => e.message);
    await vi.advanceTimersByTimeAsync(MAX_RAW_MAIL_READ_MS);
    expect(await result).toBe("mail read aborted");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline immediately on size refusal even if cancel stalls", async () => {
    fakeClock();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(MAX_RAW_MAIL_BYTES + 1)); }, cancel });
    await expect(readOriginalMail(stream)).rejects.toThrow("message too large");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans timers and abort listeners on source failure without exposing the error at ingress", async () => {
    fakeClock();
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("private source failure")); } });
    await expect(readOriginalMail(stream)).rejects.toThrow("private source failure");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
