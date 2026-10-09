import { afterEach, describe, expect, it, vi } from "vitest";
import { createDkimResolver, verifyIndependentDkim } from "../src/mail/dkim";
import { readBoundedMail } from "../src/mail/raw";
import fixtures from "./fixtures/dkim.json";

const name = "test._domainkey.example.com";
const keyResponse = (body?: ReadableStream<Uint8Array>) => body
  ? new Response(body, { headers: { "content-type": "application/dns-json" } })
  : Response.json({ Status: 0, Question: [{ name, type: 16 }], Answer: [{ name, type: 16,
    data: fixtures.record.match(/.{1,200}/g)!.map(s => `"${s}"`).join(" ") }] },
  { headers: { "content-type": "application/dns-json" } });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("whole-query DKIM DNS deadlines", () => {
  it("bounds a fetch which never settles and ignores abort", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (_, options) => {
      signal = options!.signal!;
      return new Promise(() => {});
    };
    const result = createDkimResolver(fetcher)(name, "TXT").catch(e => e.message);
    await vi.advanceTimersByTimeAsync(1999);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("key lookup budget");
    expect(signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns unknown proof even when DNS transport cannot be cancelled", async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = async () => new Promise(() => {});
    const proof = verifyIndependentDkim(new TextEncoder().encode(fixtures.valid), "member@example.com",
      Date.parse(fixtures.now) + 120_000, createDkimResolver(fetcher));
    await vi.advanceTimersByTimeAsync(2000);
    expect((await proof).authentication).toBe("unknown");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("bounds a stalled body even with a stalled cancel callback (%s)", async stalledCancel => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => stalledCancel ? new Promise<void>(() => {}) : undefined);
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"Status":0,')); }, cancel });
    const result = createDkimResolver(async () => keyResponse(body))(name, "TXT").catch(e => e.message);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe("key lookup budget");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes a valid late response without reading or admitting its key", async () => {
    vi.useFakeTimers();
    let resolve!: (r: Response) => void;
    const fetcher: typeof fetch = async () => new Promise(r => { resolve = r; });
    const result = createDkimResolver(fetcher)(name, "TXT").catch(e => e.message);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe("key lookup budget");
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    resolve(keyResponse(body));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the remaining shared budget rather than a fresh two seconds", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1 ? keyResponse() : new Promise<Response>(() => {}));
    const lookup = createDkimResolver(fetcher);
    expect(await lookup(name, "TXT")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4500);
    const result = lookup(name, "TXT").catch(e => e.message);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBe("key lookup budget");
    await expect(lookup(name, "TXT")).rejects.toThrow("budget");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([503, 302, 200])("cancels refused response bodies (status=%s)", async status => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(createDkimResolver(async () => new Response(body, { status,
      headers: { "content-type": "text/plain" } }))(name, "TXT")).rejects.toThrow("refused");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("bounded byte reader cancellation", () => {
  it("rejects an already-aborted read, cancels and unlocks without pulling", async () => {
    const controller = new AbortController();
    controller.abort("private abort reason");
    const cancel = vi.fn(), pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    await expect(readBoundedMail(body, 16, controller.signal)).rejects.toThrow("mail read aborted");
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("bounds pending reads independently of cancellation completion", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const result = readBoundedMail(body, 16, controller.signal).catch(e => e.message);
    controller.abort("private abort reason");
    expect(await result).toBe("mail read aborted");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("bounds oversize failure even if the source's cancel callback stalls", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(17)); }, cancel });
    await expect(readBoundedMail(body, 16)).rejects.toThrow("message too large");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("removes the abort listener after a successful original-byte read", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0, 255])); c.close(); }, cancel });
    expect(await readBoundedMail(body, 16, controller.signal)).toEqual(new Uint8Array([0, 255]));
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    expect(cancel).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });
});
