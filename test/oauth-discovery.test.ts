import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedTenant } from "./helpers";
import { APEX, CLAUDE, LOOPBACK, register } from "./oauth-helpers";

const get = (url: string) => SELF.fetch(url);
const anonymousMcp = (slug: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://${slug}.pimwell.test/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
const good = (redirect = LOOPBACK) => ({ client_name: "Claude Code", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });

describe("discovery", () => {
  it("serves RFC 8414 metadata on the apex only", async () => {
    const res = await get(`${APEX}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      issuer: "https://pimwell.test",
      authorization_endpoint: "https://pimwell.test/oauth/authorize",
      token_endpoint: "https://pimwell.test/oauth/token",
      registration_endpoint: "https://pimwell.test/oauth/register",
      revocation_endpoint: "https://pimwell.test/oauth/revoke",
      scopes_supported: ["read", "write"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
    });
    expect((await get("https://acme.pimwell.test/.well-known/oauth-authorization-server")).status).toBe(404);
  });

  it("serves RFC 9728 metadata whose resource is exactly the tenant URL, for any valid label", async () => {
    await seedTenant("acme");
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      expect(await (await get(`https://acme.pimwell.test${path}`)).json()).toEqual({
        resource: "https://acme.pimwell.test/mcp", authorization_servers: ["https://pimwell.test"], scopes_supported: ["read", "write"], bearer_methods_supported: ["header"],
      });
    }
    expect(((await (await get("https://nosuch.pimwell.test/.well-known/oauth-protected-resource/mcp")).json()) as any).resource).toBe("https://nosuch.pimwell.test/mcp");
    expect((await get(`${APEX}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404);
    expect((await get("https://mcp.pimwell.test/.well-known/oauth-protected-resource/mcp")).status).toBe(404);
  });

  it("challenges anonymous /mcp identically for real and unknown tenants", async () => {
    await seedTenant("acme");
    const real = await anonymousMcp("acme");
    const unknown = await anonymousMcp("nosuch");
    expect(real.status).toBe(401);
    expect(real.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://acme.pimwell.test/.well-known/oauth-protected-resource/mcp", scope="read write"');
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://nosuch.pimwell.test/.well-known/oauth-protected-resource/mcp", scope="read write"');
    expect(await real.text()).toBe(await unknown.text());
    expect((await SELF.fetch(`${APEX}/mcp`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("refuses browser origins other than the assistants", async () => {
    expect((await anonymousMcp("acme", { origin: "https://evil.example" })).status).toBe(403);
    expect((await anonymousMcp("acme", { origin: "https://claude.ai" })).status).toBe(401);
  });
});

describe("dynamic client registration", () => {
  it("registers public clients with allowed redirect URIs and records it", async () => {
    for (const redirect of [LOOPBACK, CLAUDE]) {
      const res = await register(good(redirect));
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.client_id).toMatch(/\S+/);
      expect(body.redirect_uris).toEqual([redirect]);
      expect(body.client_secret).toBeUndefined();
    }
    const ev = await env.HUB_DB.prepare("SELECT summary FROM event WHERE kind = 'oauth.client.register'").all<{ summary: string }>();
    expect(ev.results.map((r) => r.summary)).toEqual(['Registered "Claude Code"', 'Registered "Claude Code"']);
  });

  it("rejects redirect URIs off the allowlist, confidential clients, and junk", async () => {
    const bad = async (body: unknown) => {
      const res = await SELF.fetch(`${APEX}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, error: ((await res.json()) as any).error };
    };
    expect(await bad(good("https://evil.example/callback"))).toEqual({ status: 400, error: "invalid_redirect_uri" });
    expect(await bad({ ...good(), redirect_uris: [LOOPBACK, "https://evil.example/cb"] })).toEqual({ status: 400, error: "invalid_redirect_uri" });
    expect(await bad({ ...good(), redirect_uris: [] })).toEqual({ status: 400, error: "invalid_redirect_uri" });
    expect(await bad({ ...good(), token_endpoint_auth_method: "client_secret_basic" })).toEqual({ status: 400, error: "invalid_client_metadata" });
    expect(await bad([1, 2])).toEqual({ status: 400, error: "invalid_client_metadata" });
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event").first<{ n: number }>())!.n).toBe(0);
    expect((await SELF.fetch("https://acme.pimwell.test/oauth/register", { method: "POST", body: JSON.stringify(good()) })).status).toBe(404);
  });

  it("limits registrations per IP", async () => {
    for (let i = 0; i < 10; i++) expect((await register(good(), "198.51.100.7")).status).toBe(201);
    const res = await register(good(), "198.51.100.7");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await register(good(), "198.51.100.8")).status).toBe(201);
  });
});
