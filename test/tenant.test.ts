import { describe, expect, it } from "vitest";
import { classifyHost, isValidSlug, isValidTenantSlug } from "../src/tenant";

describe("classifyHost", () => {
  it("recognises the apex", () => {
    expect(classifyHost("pimwell.test", "pimwell.test")).toEqual({ kind: "apex" });
  });
  it("recognises a tenant label", () => {
    expect(classifyHost("acme.pimwell.test", "pimwell.test")).toEqual({ kind: "tenant", slug: "acme" });
  });
  it("lowercases and strips a port", () => {
    expect(classifyHost("Acme.Pimwell.test:443", "pimwell.test")).toEqual({ kind: "tenant", slug: "acme" });
  });
  it("treats reserved labels, deep labels, foreign hosts and missing header as unknown", () => {
    for (const h of ["mcp.pimwell.test", "a.b.pimwell.test", "evil.example", "pimwell.test.evil.example", "_x.pimwell.test"]) {
      expect(classifyHost(h, "pimwell.test")).toEqual({ kind: "unknown" });
    }
    expect(classifyHost(null, "pimwell.test")).toEqual({ kind: "unknown" });
  });
  it("supports localhost for dev", () => {
    expect(classifyHost("acme.localhost:8787", "localhost")).toEqual({ kind: "tenant", slug: "acme" });
    expect(classifyHost("localhost:8787", "localhost")).toEqual({ kind: "apex" });
  });
});

describe("slugs", () => {
  it("accepts dns-label-like slugs", () => {
    expect(isValidSlug("acme")).toBe(true);
    expect(isValidSlug("a-1")).toBe(true);
    expect(isValidSlug("a".repeat(63))).toBe(true);
  });
  it("rejects bad slugs", () => {
    for (const s of ["", "-a", "a-", "A", "a_b", "a.b", "a".repeat(64)]) expect(isValidSlug(s)).toBe(false);
  });
  it("rejects reserved tenant labels", () => {
    for (const s of ["www", "mail", "mx", "api", "mcp", "login", "signup", "admin", "root", "static", "cdn"]) {
      expect(isValidTenantSlug(s)).toBe(false);
    }
    expect(isValidTenantSlug("acme")).toBe(true);
  });
});
