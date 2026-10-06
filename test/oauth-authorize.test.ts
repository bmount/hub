import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cleanNext, landingUrl } from "../src/auth/login";
import { createAuthLink } from "../src/db/authLinks";
import { apiPost, bearer, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import {
  APEX, CLAUDE, LOOPBACK, authorize, decide, formTokenOf, pendingIdOf, pkce, registerClient, resourceFor, viewConsent,
} from "./oauth-helpers";

async function setup(role: "member" | "reader" = "member") {
  const acme = await seedTenant("acme");
  const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: acme.id, role }] });
  const client_id = await registerClient();
  const { verifier, challenge } = await pkce();
  return { acme, h, client_id, verifier, challenge };
}

async function pendingFor(client_id: string, challenge: string, opts: { resource?: string; redirect_uri?: string } = {}) {
  const res = await authorize({ client_id, challenge, resource: opts.resource, redirect_uri: opts.redirect_uri });
  expect(res.status).toBe(302);
  return pendingIdOf(res);
}

const staleProof = (sessionId: string, minutes: number) =>
  env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - minutes * 60_000, sessionId).run();

function errorOf(res: Response): URLSearchParams {
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  expect(`${loc.origin}${loc.pathname}`).toBe(LOOPBACK);
  return loc.searchParams;
}

describe("authorize", () => {
  it("parks the request and sends the browser to sign in, then back to consent", async () => {
    const { client_id, challenge } = await setup();
    const id = await pendingFor(client_id, challenge);
    const res = await viewConsent(id, null);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(`/oauth/consent/${id}`)}`);
    const login = await (await SELF.fetch(`${APEX}${res.headers.get("location")}`)).text();
    expect(login).toContain(`name="next" value="/oauth/consent/${id}"`);
    expect(cleanNext(`/oauth/consent/${id}`)).toBe(`/oauth/consent/${id}`);
    expect(cleanNext("/oauth/consent/short")).toBeNull();
    expect(cleanNext("//evil.example/x")).toBeNull();
    const h = await seedHuman("x@example.com");
    expect(await landingUrl(env, h.identity, `/oauth/consent/${id}`)).toBe(`https://pimwell.test/oauth/consent/${id}`);
  });

  it("returns from a magic-link sign-in to the consent page", async () => {
    const { h, client_id, challenge } = await setup();
    const id = await pendingFor(client_id, challenge);
    const next = encodeURIComponent(`/oauth/consent/${id}`);
    const { token } = await createAuthLink(env.HUB_DB, h.identity.id, "login", Date.now());
    const page = await (await SELF.fetch(`${APEX}/auth/${token}?next=${next}`)).text();
    expect(page).toContain(`action="/auth/${token}?next=/oauth/consent/${id}"`);
    const res = await SELF.fetch(`${APEX}/auth/${token}?next=/oauth/consent/${id}`, { method: "POST", redirect: "manual", headers: { origin: APEX } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${APEX}/oauth/consent/${id}`);
    const cookie = /pmw_session=([^;]+)/.exec(res.headers.get("set-cookie")!)![1]!;
    expect((await viewConsent(id, cookie)).status).toBe(200);
  });

  it("treats an omitted scope as read", async () => {
    const { h, client_id, challenge } = await setup();
    const id = pendingIdOf(await authorize({ client_id, challenge, scope: null }));
    expect(await (await viewConsent(id, h.token)).text()).toContain("See projects, activity, and your profile in ACME.");
  });

  it("forgets a request after 30 minutes", async () => {
    const { h, client_id, challenge } = await setup();
    const id = await pendingFor(client_id, challenge);
    const stored = (await env.OAUTH_KV.get<Record<string, unknown>>(`pending:${id}`, "json"))!;
    await env.OAUTH_KV.put(`pending:${id}`, JSON.stringify({ ...stored, created_at: Date.now() - 31 * 60_000 }));
    expect(await (await viewConsent(id, h.token)).text()).toContain("You do not have access to this workspace");
  });

  it("never redirects to a URI off the allowlist or not registered for the client", async () => {
    const { client_id, challenge } = await setup();
    for (const redirect_uri of ["https://evil.example/callback", CLAUDE]) {
      const res = await authorize({ client_id, challenge, redirect_uri });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    const unknown = await authorize({ client_id: "no-such-client", challenge });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("location")).toBeNull();
  });

  it("redirects protocol errors once the client and redirect URI are trusted", async () => {
    const { client_id, challenge } = await setup();
    for (const resource of [null, "https://acme.pimwell.test/mcp/", "https://mcp.pimwell.test/mcp", "https://evil.example/mcp"]) {
      const q = errorOf(await authorize({ client_id, challenge, resource }));
      expect({ resource, error: q.get("error") }).toEqual({ resource, error: "invalid_target" });
      expect(q.get("state")).toBe("st-123");
    }
    expect(errorOf(await authorize({ client_id, challenge, method: "plain" })).get("error")).toBe("invalid_request");
    expect(errorOf(await authorize({ client_id, challenge, method: null })).get("error")).toBe("invalid_request");
    expect(errorOf(await authorize({ client_id, challenge, scope: "write" })).get("error")).toBe("invalid_scope");
    expect(errorOf(await authorize({ client_id, challenge, scope: "read admin" })).get("error")).toBe("invalid_scope");
  });
});

describe("consent page", () => {
  it("shows where codes go, who is signed in, and what is granted, with anti-framing headers", async () => {
    const { h, client_id, challenge } = await setup();
    const res = await viewConsent(await pendingFor(client_id, challenge), h.token);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' http://localhost:33418");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).toContain("<strong>ACME</strong> (<code>acme.pimwell.test</code>)");
    expect(html).toContain("localhost:33418");
    expect(html).toContain("This connects a program on your own computer.");
    expect(html).toContain('"Claude Code" (name supplied by the app)');
    expect(html).toContain("ann@example.com");
    expect(html).toContain("See projects, activity, and your profile in ACME.");
    expect(html).toContain("<code>event_list</code>");
    expect(html).toContain('action="/api/session.end"');
    expect(formTokenOf(html)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("names claude.ai as the destination for Claude, lists only tools the role allows, and escapes the client name", async () => {
    const acme = await seedTenant("acme");
    const r = await seedHuman("rita@example.com", { memberships: [{ tenant_id: acme.id, role: "reader" }] });
    const client_id = await registerClient(CLAUDE, '<img src=x onerror="alert(1)">');
    const { challenge } = await pkce();
    const html = await (await viewConsent(await pendingFor(client_id, challenge, { redirect_uri: CLAUDE }), r.token)).text();
    expect(html).toContain(">claude.ai</p>");
    expect(html).not.toContain("own computer");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("<code>project_list</code>");
    expect(html).not.toContain("<code>event_list</code>");
  });

  it("asks for fresh proof after 600 minutes", async () => {
    const { h, client_id, challenge } = await setup();
    const id = await pendingFor(client_id, challenge);
    await staleProof(h.session.id, 601);
    const res = await viewConsent(id, h.token);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/login?reproof=1&next=${encodeURIComponent(`/oauth/consent/${id}`)}`);
    await staleProof(h.session.id, 599);
    expect((await viewConsent(id, h.token)).status).toBe(200);
  });

  it("binds the request to the first session that views it", async () => {
    const { acme, h, client_id, challenge } = await setup();
    const other = await seedHuman("bob@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const id = await pendingFor(client_id, challenge);
    expect((await viewConsent(id, h.token)).status).toBe(200);
    const html = await (await viewConsent(id, other.token)).text();
    expect(html).toContain("You do not have access to this workspace");
    expect(html).not.toContain("form_token");
  });

  it("shows the same neutral page for a tenant you cannot use and one that does not exist", async () => {
    await seedTenant("acme");
    const outsider = await seedHuman("out@example.com");
    const client_id = await registerClient();
    const { challenge } = await pkce();
    const a = await (await viewConsent(await pendingFor(client_id, challenge, { resource: resourceFor("acme") }), outsider.token)).text();
    const b = await (await viewConsent(await pendingFor(client_id, challenge, { resource: resourceFor("nosuch") }), outsider.token)).text();
    expect(a).toBe(b);
    expect(a).toContain("You do not have access to this workspace");
  });
});

describe("approve and deny", () => {
  async function viewed() {
    const s = await setup();
    const id = await pendingFor(s.client_id, s.challenge);
    const formToken = formTokenOf(await (await viewConsent(id, s.h.token)).text());
    return { ...s, id, formToken };
  }

  it("approves through the verb: grant, oauth session, code redirect, event, single use", async () => {
    const { acme, h, client_id, id, formToken } = await viewed();
    const res = await decide(id, h.token, formToken, "approve");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(LOOPBACK);
    expect(loc.searchParams.get("code")).toMatch(/^[^:]+:[^:]+:[^:]+$/);
    expect(loc.searchParams.get("state")).toBe("st-123");
    expect(loc.searchParams.get("iss")).toBe("https://pimwell.test");
    const grant = await env.HUB_DB.prepare("SELECT * FROM oauth_grant").first<Record<string, unknown>>();
    expect(grant).toMatchObject({
      identity_id: h.identity.id, tenant_id: acme.id, client_id, client_name: "Claude Code", client_kind: "dcr", redirect_host: "loopback",
      resource: "https://acme.pimwell.test/mcp", scopes: "read", approved_by_session_id: h.session.id, revoked_at: null,
    });
    expect(grant!.library_grant_id).toBe(loc.searchParams.get("code")!.split(":")[1]);
    const session = await env.HUB_DB.prepare("SELECT * FROM session WHERE id = ?").bind(grant!.session_id).first<Record<string, unknown>>();
    expect(session).toMatchObject({ kind: "oauth", tenant_id: acme.id, label: "Claude Code", identity_id: h.identity.id });
    const ev = await env.HUB_DB.prepare("SELECT * FROM event WHERE kind = 'oauth.grant.approve'").first<Record<string, unknown>>();
    expect(ev).toMatchObject({ tenant_id: acme.id, identity_id: h.identity.id, session_id: h.session.id, target_id: grant!.id });
    expect((await decide(id, h.token, formToken, "approve")).status).toBe(200);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM oauth_grant").first<{ n: number }>())!.n).toBe(1);
  });

  it("denies back to the client with access_denied", async () => {
    const { h, id, formToken } = await viewed();
    const q = errorOf(await decide(id, h.token, formToken, "deny"));
    expect(q.get("error")).toBe("access_denied");
    expect(q.get("state")).toBe("st-123");
    expect(await env.HUB_DB.prepare("SELECT kind FROM event WHERE kind = 'oauth.grant.deny'").first()).not.toBeNull();
    expect((await decide(id, h.token, formToken, "approve")).status).toBe(200);
    expect(await env.HUB_DB.prepare("SELECT 1 FROM oauth_grant").first()).toBeNull();
  });

  it("refuses a missing Origin, a wrong form token, and a stale proof", async () => {
    const { h, id, formToken } = await viewed();
    expect((await decide(id, h.token, formToken, "approve", { cookie: `pmw_session=${h.token}` })).status).toBe(403);
    expect((await decide(id, h.token, formToken, "approve", cookieHeaders(h.token, "evil.example"))).status).toBe(403);
    expect(await (await decide(id, h.token, "x".repeat(43), "approve")).text()).toContain("You do not have access");
    await staleProof(h.session.id, 601);
    const res = await decide(id, h.token, formToken, "approve");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/login?reproof=1&next=${encodeURIComponent(`/oauth/consent/${id}`)}`);
    const api = await apiPost("pimwell.test", "oauth.grant.approve", { pending_id: id, form_token: formToken }, bearer(h.token));
    expect(((await api.json()) as any).error).toBe("reproof_required");
    expect(await env.HUB_DB.prepare("SELECT 1 FROM oauth_grant").first()).toBeNull();
  });
});
