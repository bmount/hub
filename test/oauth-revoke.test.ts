import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authServer } from "../src/oauth/config";
import { apiPost, bearer, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { connectWithTokens, mcpPost, refresh, resourceFor } from "./oauth-helpers";

async function connected() {
  const acme = await seedTenant("acme");
  const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const c = await connectWithTokens(h.token);
  const grant = (await env.HUB_DB.prepare("SELECT * FROM oauth_grant").first<Record<string, any>>())!;
  return { acme, h, c, grant };
}

const libraryValid = (access: string) => authServer(env, resourceFor("acme")).validateToken(resourceFor("acme"), access, env);

describe("revoking an assistant", () => {
  it("lists it on /me and revokes it from there, effective on the next call", async () => {
    const { h, c, grant } = await connected();
    const html = await (await SELF.fetch("https://pimwell.test/me", { headers: { cookie: `pmw_session=${h.token}` } })).text();
    expect(html).toContain("<h2>Assistants</h2>");
    expect(html).toContain('"Claude Code"');
    expect(html).toContain("<code>loopback</code>");
    expect(html).toContain(`<code>${grant.session_id}</code>`);
    expect(html).toContain(`name="session_id" value="${grant.session_id}"`);
    expect(html).not.toContain(c.tokens.access_token);
    const res = await SELF.fetch("https://pimwell.test/api/session.revoke", {
      method: "POST", redirect: "manual",
      headers: { ...cookieHeaders(h.token, "pimwell.test"), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ session_id: grant.session_id, _back: "/me" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(await env.HUB_DB.prepare("SELECT revoke_reason, revoked_by FROM oauth_grant").first()).toEqual({ revoke_reason: "user", revoked_by: h.identity.id });
    expect((await mcpPost("acme", c.tokens.access_token, "tools/list")).status).toBe(401);
    expect((await refresh(c.client_id, c.tokens.refresh_token)).status).toBe(400);
    expect(await libraryValid(c.tokens.access_token)).toBeNull();
    const ev = await env.HUB_DB.prepare("SELECT session_id FROM event WHERE kind = 'oauth.grant.revoke'").first<{ session_id: string }>();
    expect(ev!.session_id).toBe(h.session.id);
    const after = await (await SELF.fetch("https://pimwell.test/me", { headers: { cookie: `pmw_session=${h.token}` } })).text();
    expect(after).not.toContain(`<code>${grant.session_id}</code>`);
  });

  it("lets a tenant admin revoke a member's assistant, and nobody else", async () => {
    const { acme, c, grant } = await connected();
    const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: acme.id, role: "admin" }] });
    const peer = await seedHuman("peer@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: grant.session_id }, bearer(peer.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "session.revoke", { session_id: grant.session_id }, bearer(admin.token))).status).toBe(200);
    expect(await env.HUB_DB.prepare("SELECT revoke_reason FROM oauth_grant").first()).toEqual({ revoke_reason: "admin" });
    expect((await mcpPost("acme", c.tokens.access_token, "tools/list")).status).toBe(401);
  });

  it("revokes every grant in a tenant when the tenant is archived", async () => {
    const { c } = await connected();
    const root = await seedHuman("root@example.com", { is_root: true });
    expect((await apiPost("pimwell.test", "tenant.archive", { slug: "acme" }, bearer(root.token))).status).toBe(200);
    expect(await env.HUB_DB.prepare("SELECT revoke_reason FROM oauth_grant").first()).toEqual({ revoke_reason: "tenant_archived" });
    expect(await libraryValid(c.tokens.access_token)).toBeNull();
    expect((await apiPost("pimwell.test", "tenant.unarchive", { slug: "acme" }, bearer(root.token))).status).toBe(200);
    expect((await mcpPost("acme", c.tokens.access_token, "tools/list")).status).toBe(401);
  });
});
