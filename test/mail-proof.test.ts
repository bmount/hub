import { describe, expect, it } from "vitest";
import { proofFromReply } from "../src/mail/proof";

describe("Cloudflare reply proof", () => {
  it("records proof only after the trusted platform gate succeeds", () => {
    expect(proofFromReply("sent")).toEqual({ authentication: "pass", source: "cloudflare_reply", reason: null });
  });
  it.each(["failed", "no_consent"] as const)("records %s as unknown, never DMARC fail", (result) => {
    expect(proofFromReply(result)).toEqual({ authentication: "unknown", source: null,
      reason: `authentication unknown: Cloudflare reply proof unavailable (notification=${result}); no DMARC failure inferred` });
  });
});
