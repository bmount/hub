import { describe, expect, it } from "vitest";
import { randomToken, sha256Hex, timingSafeEqual, ulid } from "../src/ids";

describe("ulid", () => {
  it("is 26 chars of Crockford base32 and sorts by time", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_001_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(a.slice(0, 10)).toBe(ulid(1_700_000_000_000).slice(0, 10));
  });
});

describe("randomToken", () => {
  it("has the prefix and 43 url-safe chars, and does not repeat", () => {
    const t = randomToken("pms_");
    expect(t).toMatch(/^pms_[A-Za-z0-9_-]{43}$/);
    expect(randomToken("pms_")).not.toBe(t);
  });
});

describe("sha256Hex", () => {
  it("matches a known vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("timingSafeEqual", () => {
  it("compares strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
