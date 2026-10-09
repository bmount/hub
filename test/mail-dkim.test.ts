import { describe, expect, it, vi } from "vitest";
import fixtures from "./fixtures/dkim.json";
import { createDkimResolver, verifyIndependentDkim } from "../src/mail/dkim";
import { readBoundedMail } from "../src/mail/raw";
import { verifyDkimInWorker } from "../src/mail/dkim-worker";

const now = Date.parse(fixtures.now) + 120_000;
const encode = (s: string) => new TextEncoder().encode(s);
const resolver = vi.fn(async () => [[fixtures.record]]);
const verify = (s: string, from = "member@example.com") => verifyIndependentDkim(encode(s), from, now, resolver);

describe("independent strict DKIM proof in Workers", () => {
  it("verifies an original RSA signed fixture without sending mail", async () => {
    expect(await verify(fixtures.valid)).toEqual({ authentication: "pass", source: "aligned_dkim",
      domain: "example.com", messageId: "<dkim-fixture@example.com>" });
    expect(resolver).toHaveBeenCalledWith("test._domainkey.example.com", "TXT");
  });
  it("verifies an Ed25519 signed fixture using the native library path", async () => {
    expect((await verifyIndependentDkim(encode(fixtures.ed25519), "member@example.com", now,
      async () => [[fixtures.edRecord]])).authentication).toBe("pass");
  });
  it("rejects otherwise cryptographically passing but incomplete signatures", async () => {
    for (const raw of [fixtures.limitedFull, fixtures.unsignedCc]) {
      const result = await verifyDkimInWorker(encode(raw), { resolver, sender: "member@example.com", curTime: now, strict: true, minBitLength: 2048 });
      expect(result.results[0]!.status.result).toBe("pass");
      expect((await verify(raw)).authentication).toBe("unknown");
    }
  });
  it("does not authorize a testing-mode key", async () => {
    expect((await verifyIndependentDkim(encode(fixtures.valid), "member@example.com", now,
      async () => [[fixtures.record + "; t=y"]])).authentication).toBe("unknown");
  });
  it.each(["unaligned", "expired", "future", "limited", "limitedFull", "unsignedCc"] as const)("fails closed on %s", async (name) => {
    expect((await verify(fixtures[name])).authentication).toBe("unknown");
  });
  it.each([
    ["body", (s: string) => s.replace("Original body.", "Forged body.")],
    ["suffix", (s: string) => s + "Unsigned request.\r\n"],
    ["subject", (s: string) => s.replace("Subject: Signed fixture", "Subject: Forged")],
    ["Cc", (s: string) => s.replace("copied@example.com", "attacker@example.com")],
    ["From", (s: string) => s.replace("member@example.com", "other@example.com")],
    ["duplicate From", (s: string) => "From: member@example.com\r\n" + s],
    ["multiple From", (s: string) => s.replace("Member <member@example.com>", "member@example.com, other@example.com")],
    ["group From", (s: string) => s.replace("Member <member@example.com>", "Authors: member@example.com;")],
    ["duplicate Cc", (s: string) => "Cc: attacker@example.com\r\n" + s],
    ["unsigned Reply-To", (s: string) => "Reply-To: attacker@example.com\r\n" + s],
    ["unsigned Content-Disposition", (s: string) => "Content-Disposition: attachment\r\n" + s],
    ["duplicate Message-ID", (s: string) => "Message-ID: <injected@example.com>\r\n" + s],
    ["LF framing", (s: string) => s.replaceAll("\r\n", "\n")],
    ["signature", (s: string) => s.replace(/b=([A-Za-z0-9])/, (_, c) => `b=${c === "A" ? "B" : "A"}`)],
  ])("fails closed on altered %s", async (_, alter) => {
    expect((await verify(alter(fixtures.valid))).authentication).toBe("unknown");
  });
  it("rejects a mismatched expected member envelope", async () => {
    expect((await verify(fixtures.valid, "other@example.com")).authentication).toBe("unknown");
  });
  it("never trusts forged Authentication-Results or ARC claims", async () => {
    expect((await verify("Authentication-Results: mx; dkim=pass; dmarc=pass\r\nARC-Authentication-Results: i=1; mx; dkim=pass\r\n" + fixtures.raw)).authentication).toBe("unknown");
  });
  it("keeps key errors and revoked keys unknown, with no raw exception output", async () => {
    for (const lookup of [async () => { throw new Error("private diagnostic"); }, async () => [["v=DKIM1; p="]]]) {
      const proof = await verifyIndependentDkim(encode(fixtures.valid), "member@example.com", now, lookup);
      expect(proof.authentication).toBe("unknown");
      expect(JSON.stringify(proof)).not.toContain("private diagnostic");
    }
  });
  it("is a proof candidate, not replay authorization", async () => {
    // The same original signature remains valid: admission must reserve this key atomically.
    expect(await verify(fixtures.valid)).toEqual(await verify(fixtures.valid));
  });
  it("bounds headers and signature count before DNS", async () => {
    const lookup = vi.fn(async () => [[fixtures.record]]);
    for (const raw of ["X-Large: " + "x".repeat(65536) + "\r\n" + fixtures.valid,
      "DKIM-Signature: a=rsa-sha256\r\n".repeat(6) + fixtures.valid]) {
      expect((await verifyIndependentDkim(encode(raw), "member@example.com", now, lookup)).authentication).toBe("unknown");
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});

function dnsResponse(name: string, data = fixtures.record.match(/.{1,200}/g)!.map((s) => `"${s}"`).join(" ")) {
  return Response.json({ Status: 0, TC: false, Question: [{ name, type: 16 }],
    Answer: [{ name, type: 16, TTL: 300, data }] }, { headers: { "content-type": "application/dns-json" } });
}
const name = "test._domainkey.example.com";
describe("bounded trusted DKIM DoH", () => {
  it("uses only a fixed HTTPS authority and returns split TXT segments", async () => {
    const fetcher = vi.fn(async () => dnsResponse(name, '"v=DKIM1; " "p=test"'));
    expect(await createDkimResolver(fetcher)(name, "TXT")).toEqual([["v=DKIM1; ", "p=test"]]);
    const [url, options] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe("https://cloudflare-dns.com/dns-query");
    expect(url.searchParams.get("name")).toBe(name);
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it("rejects arbitrary query names and types without network access", async () => {
    const fetcher = vi.fn(async () => dnsResponse(name));
    const lookup = createDkimResolver(fetcher);
    for (const [q, t] of [["evil.test", "TXT"], [name, "A"], ["x._domainkey.example.com/path", "TXT"]]) {
      await expect(lookup(q!, t!)).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("limits per-message network lookups", async () => {
    const fetcher = vi.fn(async () => dnsResponse(name));
    const lookup = createDkimResolver(fetcher);
    for (let i = 0; i < 6; i++) await lookup(name, "TXT");
    await expect(lookup(name, "TXT")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it("fails closed on lookup errors, mismatched answers and oversized responses", async () => {
    for (const response of [new Response("denied", { status: 503 }), dnsResponse("other._domainkey.example.com"),
      dnsResponse(name, '"unsupported\\999"'),
      Response.json({ Status: 3 }, { headers: { "content-type": "application/dns-json" } }),
      new Response("x".repeat(16385), { headers: { "content-type": "application/dns-json" } })]) {
      await expect(createDkimResolver(async () => response)(name, "TXT")).rejects.toThrow();
    }
  });
  it("aborts a lookup after the bounded deadline", async () => {
    const fetcher: typeof fetch = async (_, options) => new Promise((_, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    });
    await expect(createDkimResolver(fetcher)(name, "TXT")).rejects.toThrow("aborted");
  });
});

describe("bounded original raw bytes", () => {
  it("preserves bytes across chunks and rejects actual oversize with cancellation", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encode("ab")); c.enqueue(encode("cd")); c.close(); } });
    expect(await readBoundedMail(stream, 4)).toEqual(encode("abcd"));
    const cancel = vi.fn();
    const over = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encode("abcde")); }, cancel });
    await expect(readBoundedMail(over, 4)).rejects.toThrow("message too large");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
