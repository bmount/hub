import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authServer, libraryGrantIdOf, sentinelResource, tenantOfResource } from "../src/oauth/config";
import { loadRedirectPatterns, matchRedirect, redirectAllowed } from "../src/oauth/redirects";
import { takeRateDetail } from "../src/rate";

describe("tenant resources", () => {
  it("accepts only the exact tenant MCP URL", () => {
    expect(tenantOfResource(env, "https://acme.pimwell.test/mcp")).toBe("acme");
    expect(tenantOfResource(env, "https://nosuch.pimwell.test/mcp")).toBe("nosuch");
    for (const bad of [
      null, "", "https://acme.pimwell.test/mcp/", "https://ACME.pimwell.test/mcp", "https://acme.pimwell.test:443/mcp",
      "http://acme.pimwell.test/mcp", "https://acme.pimwell.test/mcp?x=1", "https://acme.pimwell.test/MCP", "https://pimwell.test/mcp",
      "https://a.b.pimwell.test/mcp", "https://mcp.pimwell.test/mcp", "https://www.pimwell.test/mcp", "https://acme.evil.test/mcp",
      "https://acme.pimwell.test.evil/mcp",
    ]) expect(tenantOfResource(env, bad)).toBeNull();
  });

  it("reads the grant id out of library tokens", () => {
    expect(libraryGrantIdOf("01JUSER:grant123:secret")).toBe("grant123");
    for (const bad of ["", "a:b", "a::c", "a:b:c:d", "pms_abc"]) expect(libraryGrantIdOf(bad)).toBeNull();
  });

  it("builds an authorization server for a tenant resource or the sentinel alone", () => {
    expect(() => authServer(env, "https://acme.pimwell.test/mcp")).not.toThrow();
    expect(() => authServer(env, "https://evil.example/mcp")).not.toThrow();
    expect(() => authServer(env, null)).not.toThrow();
    expect(sentinelResource(env)).toBe("https://mcp.pimwell.test/mcp");
  });
});

describe("redirect allowlist", () => {
  it("allows Claude's callback and loopback callbacks on any port", async () => {
    const p = await loadRedirectPatterns(env.HUB_DB);
    expect(matchRedirect(p, "https://claude.ai/api/mcp/auth_callback")).toEqual({ host: "claude.ai", label: "Claude", loopback: false });
    expect(matchRedirect(p, "http://localhost:33418/callback")).toEqual({ host: "loopback", label: "Local app (loopback)", loopback: true });
    expect(matchRedirect(p, "http://127.0.0.1:8080/callback")).toMatchObject({ loopback: true });
    expect(matchRedirect(p, "http://localhost/callback")).toMatchObject({ loopback: true });
    expect(await redirectAllowed(env.HUB_DB, "https://claude.ai/api/mcp/auth_callback")).not.toBeNull();
  });

  it("rejects everything else", async () => {
    const p = await loadRedirectPatterns(env.HUB_DB);
    for (const bad of [
      "https://claude.ai/api/mcp/auth_callback/", "https://claude.ai/api/mcp/auth_callback?x=1", "https://claude.ai/api/mcp/auth_callback#f",
      "https://CLAUDE.ai/api/mcp/auth_callback", "https://claude.ai:443/api/mcp/auth_callback", "https://claude.ai:8443/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/../mcp/auth_callback", "https://user@claude.ai/api/mcp/auth_callback", "http://claude.ai/api/mcp/auth_callback",
      "https://claude.ai.evil.example/api/mcp/auth_callback", "https://evil.example/api/mcp/auth_callback", "https://localhost/callback",
      "http://localhost:3000/other", "http://[::1]:3000/callback", "http://192.168.1.2:3000/callback", "http://localhost.evil.example/callback",
      "http://LOCALHOST:3000/callback", "http://localhost:3000/Callback", "javascript:alert(1)", "not a url", " https://claude.ai/api/mcp/auth_callback",
      "https://claude.ai\\@evil.example/api/mcp/auth_callback",
    ]) expect({ bad, got: matchRedirect(p, bad) }).toEqual({ bad, got: null });
  });
});

describe("rate rules", () => {
  it("uses per-bucket windows and reports when to retry", async () => {
    const t0 = 60_000 * 1000;
    for (let i = 0; i < 60; i++) expect((await takeRateDetail(env.RATE, "oauth_token_client", "c1", t0)).ok).toBe(true);
    const over = await takeRateDetail(env.RATE, "oauth_token_client", "c1", t0 + 30_000);
    expect(over).toEqual({ ok: false, first: true, retryAfterS: 30 });
    expect((await takeRateDetail(env.RATE, "oauth_token_client", "c1", t0 + 30_000)).first).toBe(false);
    expect((await takeRateDetail(env.RATE, "oauth_token_client", "c1", t0 + 60_000)).ok).toBe(true);
    for (let i = 0; i < 10; i++) await takeRateDetail(env.RATE, "oauth_register_ip", "203.0.113.9", t0);
    expect((await takeRateDetail(env.RATE, "oauth_register_ip", "203.0.113.9", t0)).ok).toBe(false);
  });
});
