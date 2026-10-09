import { describe, expect, it, vi } from "vitest";
import type { DNSResolver } from "mailauth";
import fixtures from "./fixtures/dkim-framing.json";
import { verifyIndependentDkim } from "../src/mail/dkim";
import { verifyDkimInWorker } from "../src/mail/dkim-worker";

const now = Date.parse(fixtures.now) + 120_000;
const encode = (raw: string) => new TextEncoder().encode(raw);
const resolver: DNSResolver = async (q) => [[q.startsWith("ed.") ? fixtures.edRecord : fixtures.record]];
const verify = (raw: string, lookup = resolver) => verifyIndependentDkim(encode(raw), "member@example.com", now, lookup);
const options = { resolver, sender: "member@example.com", curTime: new Date(now), strict: true, minBitLength: 2048 };

describe("strict outer header byte framing", () => {
  it.each(["valid", "ed25519", "bodyControls"] as const)("accepts %s without confusing HTAB/UTF-8/folding/body bytes with controls", async (name) => {
    expect(await verify(fixtures[name])).toEqual({ authentication: "pass", source: "aligned_dkim",
      domain: "example.com", messageId: "<framing@example.com>" });
  });

  it.each(["controlSubject", "controlFold", "controlExtension"] as const)("refuses cryptographically valid %s before DNS", async (name) => {
    // mailauth owns crypto; passing crypto alone does not prove unambiguous MIME framing.
    const crypto = await verifyDkimInWorker(encode(fixtures[name]), options);
    expect(crypto.results[0]!.status.result).toBe("pass");
    const lookup = vi.fn(resolver);
    expect(await verify(fixtures[name], lookup)).toEqual({ authentication: "unknown", source: null,
      reason: "authentication unknown: independent DKIM header framing" });
    expect(lookup).not.toHaveBeenCalled();
  });

  const forbidden = [...Array.from({ length: 32 }, (_, n) => n).filter(n => n !== 9), 127];
  it.each(forbidden)("refuses outer control byte %i in values and folds before DNS", async (n) => {
    const lookup = vi.fn(resolver);
    for (const raw of [`X-Evidence: invalid${String.fromCharCode(n)}value\r\n${fixtures.valid}`,
      fixtures.valid.replace("continued subject", `continued${String.fromCharCode(n)}subject`)]) {
      expect(await verify(raw, lookup)).toEqual({ authentication: "unknown", source: null,
        reason: "authentication unknown: independent DKIM header framing" });
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});
