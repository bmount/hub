import { describe, expect, it } from "vitest";
import { readRequestBytes, requestWithBytes } from "../src/http/body";

const enc = new TextEncoder();
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}, cancel?: () => void | Promise<void>) {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) { if (index < chunks.length) c.enqueue(chunks[index++]!); else c.close(); },
    cancel,
  }, { highWaterMark: 0 });
  return new Request("https://pimwell.test/api/whoami", { method: "POST", headers, body });
}

describe("actual-byte request body bounds", () => {
  it.each<Record<string, string>>([{}, { "content-length": "1" }, { "content-length": "garbage" }, { "content-length": "-1" }, { "content-length": "0" }])("counts chunks rather than trusting length %j", async (headers) => {
    let cancelled = 0;
    const req = streamed([enc.encode("abcd"), enc.encode("ef")], headers, () => { cancelled++; });
    await expect(readRequestBytes(req, 5)).rejects.toMatchObject({ status: 413, reason: "too_large" });
    expect(cancelled).toBe(1);
    expect(req.body!.locked).toBe(false);
  });

  it("accepts exactly the limit, multiple chunks and empty chunks", async () => {
    expect(await readRequestBytes(streamed([new Uint8Array(), enc.encode("ab"), enc.encode("c")]), 3)).toEqual(enc.encode("abc"));
  });

  it("counts UTF-8 bytes before decoding", async () => {
    await expect(readRequestBytes(streamed([enc.encode("é😀")]), 5)).rejects.toMatchObject({ status: 413 });
    expect(new TextDecoder().decode(await readRequestBytes(streamed([enc.encode("é😀")]), 6))).toBe("é😀");
  });

  it("refuses an oversized declared length without pulling or awaiting cancel", async () => {
    let pulled = 0;
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ pull() { pulled++; }, cancel() { cancelled++; return new Promise(() => {}); } }, { highWaterMark: 0 });
    const req = new Request("https://pimwell.test/", { method: "POST", headers: { "content-length": "1000000" }, body });
    await expect(readRequestBytes(req, 10)).rejects.toMatchObject({ status: 413 });
    expect(pulled).toBe(0);
    expect(cancelled).toBe(1);
  });

  it("does not await a stalled cancel after actual-byte overflow", async () => {
    const req = streamed([enc.encode("too big")], {}, () => new Promise(() => {}));
    await expect(readRequestBytes(req, 2)).rejects.toMatchObject({ status: 413 });
    expect(req.body!.locked).toBe(false);
  });

  it("maps stream errors to a safe 400 without reflecting arbitrary exception text", async () => {
    const req = new Request("https://pimwell.test/", { method: "POST", body: new ReadableStream({ start(c) { c.error(new Error("private attacker supplied detail")); } }) });
    await expect(readRequestBytes(req, 10)).rejects.toMatchObject({ status: 400, detail: "request body could not be read" });
    expect(req.body!.locked).toBe(false);
  });

  it("aborts a pending read, without waiting for cancel, then releases its lock", async () => {
    const ac = new AbortController();
    let cancelled = 0;
    const req = new Request("https://pimwell.test/", { method: "POST", signal: ac.signal,
      body: new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled++; return new Promise(() => {}); } }) });
    const pending = readRequestBytes(req, 10);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ status: 400, detail: "request body aborted" });
    expect(cancelled).toBe(1);
    expect(req.body!.locked).toBe(false);
  });

  it("refuses an already aborted request", async () => {
    const ac = new AbortController(); ac.abort();
    const req = new Request("https://pimwell.test/", { method: "POST", signal: ac.signal, body: "small" });
    await expect(readRequestBytes(req, 10)).rejects.toMatchObject({ status: 400 });
    expect(req.body!.locked).toBe(false);
  });

  it("snapshots source-owned chunks, including many one-byte chunks", async () => {
    const chunk = enc.encode("a");
    let index = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) {
      if (index === 10000) { c.close(); return; }
      chunk[0] = index++ % 2 ? 98 : 97; c.enqueue(chunk);
    } }, { highWaterMark: 0 });
    const bytes = await readRequestBytes(new Request("https://pimwell.test/", { method: "POST", body }), 10000);
    chunk[0] = 122;
    expect(new TextDecoder().decode(bytes)).toBe("ab".repeat(5000));
  });

  it("rebuilds bounded form bytes with the original URL and headers, not forged framing", async () => {
    const req = streamed([enc.encode("msg=hi")], { "content-type": "application/x-www-form-urlencoded", "content-length": "1", "transfer-encoding": "chunked", origin: "https://pimwell.test" });
    const bounded = requestWithBytes(req, await readRequestBytes(req, 100));
    expect(bounded.url).toBe(req.url);
    expect(bounded.headers.get("origin")).toBe("https://pimwell.test");
    expect(bounded.headers.get("content-length")).toBeNull();
    expect(bounded.headers.get("transfer-encoding")).toBeNull();
    expect((await bounded.formData()).get("msg")).toBe("hi");
  });

  it("accepts absent bodies and rejects invalid programmer-supplied limits", async () => {
    expect(await readRequestBytes(new Request("https://pimwell.test/"), 10)).toEqual(new Uint8Array());
    for (const limit of [0, -1, NaN, Infinity, 1.5]) await expect(readRequestBytes(streamed([]), limit)).rejects.toBeInstanceOf(RangeError);
  });
});
