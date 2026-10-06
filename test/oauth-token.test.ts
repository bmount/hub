import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authServer } from "../src/oauth/config";
import { tokenEndpoint } from "../src/oauth/token";
import { seedHuman, seedTenant } from "./helpers";
import { connect, connectWithTokens, refresh, resourceFor, tokenRequest, type Tokens } from "./oauth-helpers";

async function member() {
  const acme = await seedTenant("acme");
  await seedTenant("blue");
  const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  return { acme, h };
}

const grantRow = () => env.HUB_DB.prepare("SELECT * FROM oauth_grant").first<Record<string, any>>();
const errorOf = async (res: Response) => ({ status: res.status, error: ((await res.json()) as any).error });
const validFor = (slug: string, access: string) => authServer(env, resourceFor(slug)).validateToken(resourceFor(slug), access, env);

describe("code exchange", () => {
  it("issues tokens bound to the tenant resource, with PKCE", async () => {
    const { h } = await member();
    const c = await connect(h.token);
    const res = await tokenRequest({ grant_type: "authorization_code", code: c.code, redirect_uri: c.redirect, client_id: c.client_id, code_verifier: c.verifier, resource: resourceFor("acme") });
    expect(res.status).toBe(200);
    const t = (await res.json()) as Tokens;
    expect(t).toMatchObject({ token_type: "bearer", expires_in: 3600, scope: "read", resource: "https://acme.pimwell.test/mcp" });
    expect(t.access_token.split(":")).toHaveLength(3);
    const g = await grantRow();
    expect(g!.refresh_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await validFor("acme", t.access_token))!.props).toMatchObject({ grant_id: g!.id, session_id: g!.session_id, identity_id: h.identity.id, scopes: ["read"] });
    expect(await validFor("blue", t.access_token)).toBeNull();
  });

  it("refuses a wrong verifier, a different resource, a revoked grant, and a code older than 5 minutes, all as invalid_grant until the library accepts the code", async () => {
    const { h } = await member();
    const base = async () => {
      const c = await connect(h.token);
      return { c, fields: { grant_type: "authorization_code", code: c.code, redirect_uri: c.redirect, client_id: c.client_id, code_verifier: c.verifier, resource: resourceFor("acme") } };
    };
    const a = await base();
    expect(await errorOf(await tokenRequest({ ...a.fields, code_verifier: "w".repeat(43) }))).toEqual({ status: 400, error: "invalid_grant" });
    const b = await base();
    expect(await errorOf(await tokenRequest({ ...b.fields, code_verifier: "w".repeat(43), resource: resourceFor("blue") }))).toEqual({ status: 400, error: "invalid_grant" });
    expect(await errorOf(await tokenRequest({ ...b.fields, resource: resourceFor("blue") }))).toEqual({ status: 400, error: "invalid_grant" });
    const m = await base();
    const { resource: _drop, ...noResource } = m.fields;
    // The code and verifier are right, so the library accepts; only then does the hub name the resource problem.
    expect(await errorOf(await tokenRequest(noResource))).toEqual({ status: 400, error: "invalid_target" });
    expect(await env.HUB_DB.prepare("SELECT revoke_reason FROM oauth_grant WHERE library_grant_id = ?").bind(m.c.code.split(":")[1]).first()).toEqual({ revoke_reason: "resource_mismatch" });
    const c = await base();
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = 1 WHERE library_grant_id = ?").bind(c.c.code.split(":")[1]).run();
    expect(await errorOf(await tokenRequest(c.fields))).toEqual({ status: 400, error: "invalid_grant" });
    const d = await base();
    await env.HUB_DB.prepare("UPDATE oauth_grant SET created_at = created_at - 301000 WHERE library_grant_id = ?").bind(d.c.code.split(":")[1]).run();
    expect(await errorOf(await tokenRequest(d.fields))).toEqual({ status: 400, error: "invalid_grant" });
    expect(await errorOf(await tokenRequest({ grant_type: "password", client_id: "x" }))).toEqual({ status: 400, error: "unsupported_grant_type" });
  });

  it("treats a second exchange of the same code as theft and revokes the grant", async () => {
    const { h } = await member();
    const c = await connect(h.token);
    const fields = { grant_type: "authorization_code", code: c.code, redirect_uri: c.redirect, client_id: c.client_id, code_verifier: c.verifier, resource: resourceFor("acme") };
    const first = await tokenRequest(fields);
    expect(first.status).toBe(200);
    const t = (await first.json()) as Tokens;
    expect(await validFor("acme", t.access_token)).not.toBeNull();
    expect(await errorOf(await tokenRequest(fields))).toEqual({ status: 400, error: "invalid_grant" });
    expect(await grantRow()).toMatchObject({ revoke_reason: "code_reuse" });
    expect(await validFor("acme", t.access_token)).toBeNull();
    expect((await refresh(c.client_id, t.refresh_token)).status).toBe(400);
  });
});

describe("refresh", () => {
  it("rotates, and a rotated token coming back revokes the grant", async () => {
    const { h } = await member();
    const { client_id, tokens } = await connectWithTokens(h.token);
    const r1 = await refresh(client_id, tokens.refresh_token, resourceFor("acme"));
    expect(r1.status).toBe(200);
    const t2 = (await r1.json()) as Tokens;
    expect(t2.refresh_token).not.toBe(tokens.refresh_token);
    expect(await validFor("acme", t2.access_token)).not.toBeNull();
    expect(await errorOf(await refresh(client_id, tokens.refresh_token))).toEqual({ status: 400, error: "invalid_grant" });
    expect(await grantRow()).toMatchObject({ revoke_reason: "refresh_reuse" });
    const session = await env.HUB_DB.prepare("SELECT revoked_at FROM session WHERE kind = 'oauth'").first<{ revoked_at: number | null }>();
    expect(session!.revoked_at).not.toBeNull();
    expect(await errorOf(await refresh(client_id, t2.refresh_token))).toEqual({ status: 400, error: "invalid_grant" });
    expect(await validFor("acme", t2.access_token)).toBeNull();
    const ev = await env.HUB_DB.prepare("SELECT summary FROM event WHERE kind = 'oauth.grant.revoke'").first<{ summary: string }>();
    expect(ev!.summary).toBe('Revoked "Claude Code" (refresh_reuse)');
  });

  it("treats two refreshes racing with one token as reuse", async () => {
    const { h } = await member();
    const { client_id, tokens } = await connectWithTokens(h.token);
    const results = await Promise.all([refresh(client_id, tokens.refresh_token), refresh(client_id, tokens.refresh_token)]);
    expect(results.map((r) => r.status)).toContain(400);
    expect(await grantRow()).toMatchObject({ revoke_reason: "refresh_reuse" });
  });

  it("checks the hub grant before refreshing", async () => {
    const { acme, h } = await member();
    const { client_id, tokens } = await connectWithTokens(h.token);
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ? AND tenant_id = ?").bind(h.identity.id, acme.id).run();
    expect(await errorOf(await refresh(client_id, tokens.refresh_token))).toEqual({ status: 400, error: "invalid_grant" });
    expect((await grantRow())!.revoked_at).toBeNull();
    await env.HUB_DB.prepare("UPDATE membership SET state = 'active' WHERE identity_id = ? AND tenant_id = ?").bind(h.identity.id, acme.id).run();
    expect(await errorOf(await refresh(client_id, tokens.refresh_token, resourceFor("blue")))).toEqual({ status: 400, error: "invalid_target" });
    expect((await refresh(client_id, tokens.refresh_token)).status).toBe(200);
  });
});

describe("revocation endpoint", () => {
  it("revokes the grant when the client revokes its refresh token", async () => {
    const { h } = await member();
    const { client_id, tokens } = await connectWithTokens(h.token);
    const res = await tokenRequest({ token: tokens.refresh_token, token_type_hint: "refresh_token", client_id }, "/oauth/revoke");
    expect(res.status).toBe(200);
    expect(await grantRow()).toMatchObject({ revoke_reason: "client" });
    expect(await validFor("acme", tokens.access_token)).toBeNull();
  });

  it("limits token requests per client", async () => {
    // A fixed clock, so the 61 requests cannot straddle a minute boundary.
    const now = 1_000 * 60_000;
    const ectx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const call = () => tokenEndpoint(new Request("https://pimwell.test/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=password&client_id=busy",
    }), env, ectx, now);
    for (let i = 0; i < 60; i++) expect((await call()).status).toBe(400);
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});

describe("forged and mismatched refresh tokens", () => {
  it("a forged x:<grant>:y refresh has no side effect, and the genuine tokens keep working", async () => {
    const { h } = await member();
    const { client_id, tokens } = await connectWithTokens(h.token);
    const g = (await grantRow())!;
    expect(await errorOf(await refresh(client_id, `x:${g.library_grant_id}:y`))).toEqual({ status: 400, error: "invalid_grant" });
    expect(await grantRow()).toMatchObject({ revoked_at: null, revoke_reason: null });
    const r1 = await refresh(client_id, tokens.refresh_token);
    expect(r1.status).toBe(200);
    const t2 = (await r1.json()) as Tokens;
    // Still forged after a rotation: nothing changes.
    expect(await errorOf(await refresh(client_id, `x:${g.library_grant_id}:y`))).toEqual({ status: 400, error: "invalid_grant" });
    expect((await grantRow())!.revoked_at).toBeNull();
    // The genuine retired token presented under another client_id is refused without revoking.
    expect(await errorOf(await refresh("someone-else", tokens.refresh_token))).toEqual({ status: 400, error: "invalid_grant" });
    expect((await grantRow())!.revoked_at).toBeNull();
    expect((await refresh(client_id, t2.refresh_token)).status).toBe(200);
    expect((await grantRow())!.prev_refresh_hash).not.toBeNull();
    // From its own client, the previous token is reuse.
    expect(await errorOf(await refresh(client_id, t2.refresh_token))).toEqual({ status: 400, error: "invalid_grant" });
    expect(await grantRow()).toMatchObject({ revoke_reason: "refresh_reuse" });
  });

  it("a genuine reuse of the previous token still revokes", async () => {
    const { h } = await member();
    const { client_id, tokens } = await connectWithTokens(h.token);
    expect((await refresh(client_id, tokens.refresh_token)).status).toBe(200);
    expect((await refresh(client_id, tokens.refresh_token)).status).toBe(400);
    expect(await grantRow()).toMatchObject({ revoke_reason: "refresh_reuse" });
  });

  it("revokes the hub grant when the library rejects a refresh the hub accepted", async () => {
    const { h } = await member();
    const { client_id, tokens } = await connectWithTokens(h.token);
    const g = (await grantRow())!;
    await authServer(env, resourceFor("acme")).getOAuthApi(env).revokeGrant(g.library_grant_id, h.identity.id);
    expect(await errorOf(await refresh(client_id, tokens.refresh_token))).toEqual({ status: 400, error: "invalid_grant" });
    expect(await grantRow()).toMatchObject({ revoke_reason: "library_rejected" });
    expect((await env.HUB_DB.prepare("SELECT revoked_at FROM session WHERE kind = 'oauth'").first<{ revoked_at: number | null }>())!.revoked_at).not.toBeNull();
  });
});

describe("revocation authority", () => {
  it("ignores a forged token, a wrong client, and another client's attempt with a real token", async () => {
    const { h } = await member();
    const { client_id, tokens } = await connectWithTokens(h.token);
    const g = (await grantRow())!;
    expect((await tokenRequest({ token: `x:${g.library_grant_id}:y`, client_id }, "/oauth/revoke")).status).toBe(200);
    await tokenRequest({ token: tokens.refresh_token, client_id: "someone-else" }, "/oauth/revoke");
    await tokenRequest({ token: tokens.access_token, client_id: "someone-else" }, "/oauth/revoke");
    expect((await grantRow())!.revoked_at).toBeNull();
  });

  it("revokes for the grant's client with the previous refresh token, or with an access token", async () => {
    const { h } = await member();
    const a = await connectWithTokens(h.token);
    const r1 = (await (await refresh(a.client_id, a.tokens.refresh_token)).json()) as Tokens;
    expect(r1.refresh_token).not.toBe(a.tokens.refresh_token);
    expect((await tokenRequest({ token: a.tokens.refresh_token, client_id: a.client_id }, "/oauth/revoke")).status).toBe(200);
    const byClient = (id: string) => env.HUB_DB.prepare("SELECT revoke_reason FROM oauth_grant WHERE client_id = ?").bind(id).first();
    expect(await byClient(a.client_id)).toEqual({ revoke_reason: "client" });
    const b = await connectWithTokens(h.token);
    expect(await byClient(b.client_id)).toEqual({ revoke_reason: null });
    expect((await tokenRequest({ token: b.tokens.access_token, token_type_hint: "access_token", client_id: b.client_id }, "/oauth/revoke")).status).toBe(200);
    expect(await byClient(b.client_id)).toEqual({ revoke_reason: "client" });
  });
});

describe("token endpoint limits", () => {
  it("limits token requests per IP across clients", async () => {
    const now = 2_000 * 60_000;
    const ectx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const call = (i: number) => tokenEndpoint(new Request("https://pimwell.test/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.9" }, body: `grant_type=password&client_id=c${i}`,
    }), env, ectx, now);
    for (let i = 0; i < 120; i++) expect((await call(i)).status).toBe(400);
    const res = await call(999);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});
