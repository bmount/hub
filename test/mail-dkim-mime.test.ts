import { describe, expect, it } from "vitest";
import type { DNSResolver } from "mailauth";
import fixtures from "./fixtures/dkim-mime.json";
import base from "./fixtures/dkim.json";
import { verifyIndependentDkim } from "../src/mail/dkim";
import { verifyDkimInWorker } from "../src/mail/dkim-worker";

const now = Date.parse(fixtures.now) + 120_000;
const encode = (s: string) => new TextEncoder().encode(s);
const resolver: DNSResolver = async (name) => [[name.startsWith("ed.") ? fixtures.edRecord : fixtures.record]];
const verify = (raw: string) => verifyIndependentDkim(encode(raw), "member@example.com", now, resolver);
const options = { resolver, sender: "member@example.com", curTime: new Date(now), strict: true, minBitLength: 2048 };
const mimeHeaders = ["Content-ID", "Content-Description", "Content-Language", "Content-X-Extension"];

describe("same-signature outer MIME header coverage", () => {
  it.each(["valid", "ed25519", "laterComplete"] as const)("accepts %s with fully signed mixed-case and folded MIME fields", async (name) => {
    expect(await verify(fixtures[name])).toEqual({ authentication: "pass", source: "aligned_dkim",
      domain: "example.com", messageId: "<mime-coverage@example.com>" });
  });

  it("refuses cryptographically passing signatures with unsigned outer MIME metadata", async () => {
    const result = await verifyDkimInWorker(encode(fixtures.unsignedMime), options);
    expect(result.results[0]!.status.result).toBe("pass");
    expect((await verify(fixtures.unsignedMime)).authentication).toBe("unknown");
  });

  it("cannot union coverage of two independently passing aligned signatures", async () => {
    const result = await verifyDkimInWorker(encode(fixtures.splitCoverage), options);
    expect(result.results).toHaveLength(2);
    expect(result.results.map(r => r.status.result)).toEqual(["pass", "pass"]);
    expect((await verify(fixtures.splitCoverage)).authentication).toBe("unknown");
  });

  it.each(mimeHeaders)("rejects unsigned injected %s even when the original signature still verifies", async (header) => {
    const bytes = encode(`${header}: attacker-controlled\r\n${base.valid}`);
    const lookup: DNSResolver = async () => [[base.record]];
    const result = await verifyDkimInWorker(bytes, { ...options, resolver: lookup });
    expect(result.results[0]!.status.result).toBe("pass");
    expect((await verifyIndependentDkim(bytes, "member@example.com", now, lookup)).authentication).toBe("unknown");
  });

  it.each(mimeHeaders)("rejects duplicate %s instead of trusting a parser's occurrence choice", async (header) => {
    expect((await verify(`${header.toUpperCase()}: attacker-controlled\r\n${fixtures.valid}`)).authentication).toBe("unknown");
  });

  it.each([
    ["ID", "<part@example.com>", "<forged@example.com>"],
    ["description", "\tattachment description", "\tforged description"],
    ["language", "Content-Language: en", "Content-Language: fr"],
    ["extension", "signed extension", "forged extension"],
  ])("rejects tampering with signed MIME %s", async (_, before, after) => {
    expect((await verify(fixtures.valid.replace(before!, after!))).authentication).toBe("unknown");
  });

  it("leaves transport authentication assertions as non-authoritative evidence", async () => {
    const raw = "Authentication-Results: forged; dkim=pass; dmarc=pass\r\n"
      + "ARC-Authentication-Results: i=1; forged; dkim=pass\r\n" + fixtures.valid;
    // Original crypto is the only authority; adding assertions cannot repair bad coverage.
    expect((await verify(raw)).authentication).toBe("pass");
    expect((await verify(raw.replace("Original body.", "Forged body."))).authentication).toBe("unknown");
  });
});
