import { describe, expect, it, vi } from "vitest";
import arcFixtures from "./fixtures/arc.json";
import fixtures from "./fixtures/dkim.json";
import { createDkimResolver, verifyIndependentDkim } from "../src/mail/dkim";
import { readBoundedMail } from "../src/mail/raw";
import { verifyDkimInWorker } from "../src/mail/dkim-worker";

const now = Date.parse(fixtures.now) + 120_000;
const encode = (s: string) => new TextEncoder().encode(s);
const resolver = vi.fn(async () => [[fixtures.record]]);
const verify = (s: string, from = "member@example.com") => verifyIndependentDkim(encode(s), from, now, resolver);

describe("verified Cloudflare ARC and separate instruction bar", () => {
  const check = (raw: string, time = Date.parse(arcFixtures.now) + 60_000) => verifyIndependentDkim(encode(raw), "member@example.com", time, async () => [[arcFixtures.record]]);
  it("accepts the pinned highest seal, AMS and aligned Cloudflare verdict", async () => {
    expect(await check(arcFixtures.valid)).toMatchObject({ authentication: "pass", source: "cloudflare_arc", actionEligible: true,
      results: { arc: { instance: 1, sealAndChain: "pass", messageSignature: "pass", pinnedSealer: true, authserv: true, alignedDmarc: true } } });
  });
  it.each(["untrusted", "untrustedHigher", "misaligned", "wrongAuthserv"] as const)("rejects sealed but unauthorized verdict %s", async name => {
    const crypto = await verifyDkimInWorker(encode(arcFixtures[name]), { resolver: async () => [[arcFixtures.record]], strict: true, minBitLength: 1024, curTime: new Date(arcFixtures.now) });
    expect(crypto.arcResult.status.result).toBe("pass");
    expect((await check(arcFixtures[name])).authentication).toBe("unknown");
  });
  it("verifies the highest Cloudflare set in a genuine two-instance chain", async () => {
    expect(await check(arcFixtures.validChain)).toMatchObject({ authentication: "pass", source: "cloudflare_arc",
      results: { arc: { instance: 2, sealAndChain: "pass", sets: [{ i: "2", d: "email.cloudflare.net", cv: "pass" }, { i: "1", d: "attacker.example", cv: "none" }] } } });
  });
  it("does not fall back to a valid lower set under forged higher sets", async () => {
    const higher = arcFixtures.valid.split("\r\nFrom:")[0]!.replace(/i=1/g, "i=2").replace(/cv=none/, "cv=pass");
    expect((await check(higher + "\r\n" + arcFixtures.valid)).authentication).toBe("unknown");
  });
  it("records the actual AMS outcome even when the seal is forged", async () => {
    const forged = arcFixtures.valid.replace(/b=([A-Za-z0-9])/, (_, c) => `b=${c === "A" ? "B" : "A"}`);
    expect(await check(forged)).toMatchObject({ authentication: "unknown", results: { arc: {
      sealAndChain: "fail", messageSignature: "pass", pinnedSealer: true,
      sets: [{ i: "1", d: "email.cloudflare.net", s: "test", cv: "none" }],
    } } });
  });
  it("rejects a forged seal, tampered verdict or body", async () => {
    for (const raw of [arcFixtures.valid.replace(/b=([A-Za-z0-9])/, (_, c) => `b=${c === "A" ? "B" : "A"}`), arcFixtures.valid.replace("dmarc=pass", "dmarc=fail"), arcFixtures.valid.replace("Hello.", "Forged.")])
      expect((await check(raw)).authentication).toBe("unknown");
  });
  it("admits 1024-bit M365-style DKIM without To coverage, but skips instructions", async () => {
    expect(await check(arcFixtures.m365)).toMatchObject({ authentication: "pass", source: "aligned_dkim", actionEligible: false });
  });
  it("never upgrades incomplete DKIM with forged unsigned provider verdicts", async () => {
    const forged = "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=example.com\r\nARC-Authentication-Results: i=1; mx.cloudflare.net; dmarc=pass header.from=example.com\r\n";
    expect(await check(forged + arcFixtures.m365)).toMatchObject({ authentication: "pass", source: "aligned_dkim", actionEligible: false });
  });
  it("answers older signed mail without instruction authority", async () => {
    expect(await check(arcFixtures.valid, Date.parse(arcFixtures.now) + 73 * 3600_000)).toMatchObject({ authentication: "pass", actionEligible: false });
  });
  it("never executes instructions authorized only by incomplete semantic coverage", async () => {
    for (const raw of [fixtures.unsignedCc, "Reply-To: attacker@example.com\r\n" + fixtures.valid, "Content-Disposition: attachment\r\n" + fixtures.valid])
      expect(await verify(raw)).toMatchObject({ authentication: "pass", actionEligible: false });
  });
});

describe("independent strict DKIM proof in Workers", () => {
  it("verifies an original RSA signed fixture without sending mail", async () => {
    expect(await verify(fixtures.valid)).toMatchObject({ authentication: "pass", source: "aligned_dkim",
      domain: "example.com", messageId: "<dkim-fixture@example.com>" });
    expect(resolver).toHaveBeenCalledWith("test._domainkey.example.com", "TXT");
  });
  it("verifies an Ed25519 signed fixture using the native library path", async () => {
    expect((await verifyIndependentDkim(encode(fixtures.ed25519), "member@example.com", now,
      async () => [[fixtures.edRecord]])).authentication).toBe("pass");
  });
  it("rejects otherwise cryptographically passing but incomplete signatures", async () => {
    for (const raw of [fixtures.limitedFull]) {
      const result = await verifyDkimInWorker(encode(raw), { resolver, sender: "member@example.com", curTime: now, strict: true, minBitLength: 2048 });
      expect(result.results[0]!.status.result).toBe("pass");
      expect((await verify(raw)).authentication).toBe("unknown");
    }
  });
  it("does not authorize a testing-mode key", async () => {
    expect((await verifyIndependentDkim(encode(fixtures.valid), "member@example.com", now,
      async () => [[fixtures.record + "; t=y"]])).authentication).toBe("unknown");
  });
  it.each(["unaligned", "expired", "future", "limited", "limitedFull"] as const)("fails closed on %s", async (name) => {
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
    expect(options.redirect).toBe("manual");
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
    await expect(createDkimResolver(fetcher)(name, "TXT")).rejects.toThrow("key lookup budget");
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
