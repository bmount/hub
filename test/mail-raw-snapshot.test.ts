import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { readBoundedMail } from "../src/mail/raw";
import { createDkimResolver, verifyIndependentDkim } from "../src/mail/dkim";
import fixtures from "./fixtures/dkim.json";

const encode = (s: string) => new TextEncoder().encode(s);

// Pull-only delivery lets the consumer observe each chunk before the producer
// reuses its storage on the next read. No mutation before read() resolves is
// supported/claimed: the reader must own the bytes it actually observes.
function reuse(bytes: Uint8Array, width = 97, nodeBuffer = false) {
  const storage = nodeBuffer ? Buffer.alloc(width + 4) : new Uint8Array(width + 4);
  let offset = 0;
  return new ReadableStream<Uint8Array>({ pull(c) {
    storage.fill(0xff);
    if (offset === bytes.length) { c.close(); return; }
    const length = Math.min(width, bytes.length - offset);
    storage.set(bytes.subarray(offset, offset + length), 2);
    offset += length;
    c.enqueue(storage.subarray(2, 2 + length));
  } }, { highWaterMark: 0 });
}

const time = Date.parse(fixtures.now) + 120_000;
describe("original-byte snapshots at the stream boundary", () => {
  it.each([false, true])("copies every reused offset chunk (Node Buffer=%s)", async nodeBuffer => {
    const original = new Uint8Array([0, 1, 2, 3, 254, 255, 0]);
    const stream = reuse(original, 3, nodeBuffer);
    expect(await readBoundedMail(stream, original.length)).toEqual(original);
    expect(stream.locked).toBe(false);
  });

  it.each([1, 97, 1024])("preserves signed bytes across reused chunks of size %s", async width => {
    const original = encode(fixtures.valid);
    const bytes = await readBoundedMail(reuse(original, width));
    expect(bytes).toEqual(original);
    expect((await verifyIndependentDkim(bytes, "member@example.com", time,
      async () => [[fixtures.record]])).authentication).toBe("pass");
  });

  it("also preserves native Ed25519 proof with Node Buffer chunk reuse", async () => {
    const original = encode(fixtures.ed25519);
    const bytes = await readBoundedMail(reuse(original, 113, true));
    expect(bytes).toEqual(original);
    expect((await verifyIndependentDkim(bytes, "member@example.com", time,
      async () => [[fixtures.edRecord]])).authentication).toBe("pass");
  });

  it("never replaces observed tampering with signed bytes restored only at EOF", async () => {
    const original = encode(fixtures.valid);
    const observed = encode(fixtures.valid.replace("Original body.", "Modified body."));
    expect(observed.length).toBe(original.length);
    let delivered = false;
    const stream = new ReadableStream<Uint8Array>({ pull(c) {
      if (!delivered) { delivered = true; c.enqueue(observed); }
      else { observed.set(original); c.close(); }
    } }, { highWaterMark: 0 });
    const bytes = await readBoundedMail(stream);
    expect(new TextDecoder().decode(bytes)).toContain("Modified body.");
    expect((await verifyIndependentDkim(bytes, "member@example.com", time,
      async () => [[fixtures.record]])).authentication).toBe("unknown");
  });

  it("preserves trusted DoH JSON across reused chunks before key verification", async () => {
    const name = "test._domainkey.example.com";
    const data = fixtures.record.match(/.{1,200}/g)!.map(s => `"${s}"`).join(" ");
    const raw = encode(JSON.stringify({ Status: 0, Question: [{ name, type: 16 }],
      Answer: [{ name, type: 16, data }] }));
    const lookup = createDkimResolver(async () => new Response(reuse(raw),
      { headers: { "content-type": "application/dns-json" } }));
    expect((await verifyIndependentDkim(encode(fixtures.valid), "member@example.com", time,
      lookup)).authentication).toBe("pass");
  });

  it("checks the actual byte limit before retaining another chunk", async () => {
    const stream = reuse(new Uint8Array(7), 3);
    await expect(readBoundedMail(stream, 6)).rejects.toThrow("message too large");
    expect(stream.locked).toBe(false);
  });
});
