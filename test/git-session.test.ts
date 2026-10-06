import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { introspect } from "../src/http/internal";
import { credentialUsable } from "../src/auth/context";
import { createGitSession, GIT_SESSION_TTL_S, getSessionById, revokeSession } from "../src/db/sessions";
import { apiPost, bearer, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const SECRET = "test-internal-secret";

async function introspectAs(token: string, tenant: string): Promise<any> {
  const res = await introspect(new Request("https://hub.internal/internal/introspect", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-internal": SECRET },
    body: JSON.stringify({ token, tenant }),
  }), env);
  return res.json();
}

async function setup() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const human = await seedHuman("m@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "member" }] });
  const git = await createGitSession(env.HUB_DB, { identity_id: human.identity.id, tenant_id: acme.id, label: "laptop" }, Date.now());
  return { acme, blue, human, git };
}

describe("git sessions", () => {
  it("are pinned to one tenant, last 90 days, and have no parent token", async () => {
    const { acme, human, git } = await setup();
    expect(GIT_SESSION_TTL_S).toBe(90 * 86400);
    expect(git.token.startsWith("pms_")).toBe(true);
    const row = await getSessionById(env.HUB_DB, git.session.id);
    expect(row).toMatchObject({ kind: "git", identity_id: human.identity.id, tenant_id: acme.id, label: "laptop", parent_token_id: null, revoked_at: null });
    expect(row!.expires_at - row!.created_at).toBe(GIT_SESSION_TTL_S * 1000);
  });

  it("introspect on their own tenant only", async () => {
    const { human, git } = await setup();
    expect(await introspectAs(git.token, "acme")).toEqual({
      ok: true,
      identity: { id: human.identity.id, kind: "human", display_name: "m", email: "m@example.com", operator_id: null },
      session: { id: git.session.id, kind: "git", label: "laptop" },
      tenant: { slug: "acme" },
      role: "member",
    });
    expect(await introspectAs(git.token, "blue")).toEqual({ ok: false });
  });

  it("count only on the introspection path", async () => {
    const { acme, blue, human, git } = await setup();
    expect(await credentialUsable(env.HUB_DB, human.identity, git.session, null, acme, "introspect")).toBe(true);
    expect(await credentialUsable(env.HUB_DB, human.identity, git.session, null, blue, "introspect")).toBe(false);
    expect(await credentialUsable(env.HUB_DB, human.identity, git.session, null, acme)).toBe(false);
    expect(await credentialUsable(env.HUB_DB, human.identity, git.session, null, acme, "mcp")).toBe(false);
    // Browser sessions never introspect (ruling A-1).
    expect(await credentialUsable(env.HUB_DB, human.identity, human.session, null, acme, "introspect")).toBe(false);
  });

  it("refuse a valid browser session token on introspection", async () => {
    const { human } = await setup();
    expect(await introspectAs(human.token, "acme")).toEqual({ ok: false });
  });

  it("stop introspecting when the membership ends, the session expires, or it is revoked", async () => {
    const { acme, human, git } = await setup();
    const setMembership = (state: string) => env.HUB_DB.prepare("UPDATE membership SET state = ? WHERE identity_id = ? AND tenant_id = ?").bind(state, human.identity.id, acme.id).run();
    await setMembership("archived");
    expect(await introspectAs(git.token, "acme")).toEqual({ ok: false });
    await setMembership("active");
    expect((await introspectAs(git.token, "acme")).ok).toBe(true);
    await env.HUB_DB.prepare("UPDATE session SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, git.session.id).run();
    expect(await introspectAs(git.token, "acme")).toEqual({ ok: false });
    const other = await createGitSession(env.HUB_DB, { identity_id: human.identity.id, tenant_id: acme.id, label: "desk" }, Date.now());
    expect((await introspectAs(other.token, "acme")).ok).toBe(true);
    await revokeSession(env.HUB_DB, other.session.id, Date.now());
    expect(await introspectAs(other.token, "acme")).toEqual({ ok: false });
  });

  it("record their last use without extending the expiry", async () => {
    const { git } = await setup();
    const before = Date.now() - 2 * 3600_000;
    await env.HUB_DB.prepare("UPDATE session SET last_seen_at = ? WHERE id = ?").bind(before, git.session.id).run();
    expect((await introspectAs(git.token, "acme")).ok).toBe(true);
    const row = await getSessionById(env.HUB_DB, git.session.id);
    expect(row!.last_seen_at).toBeGreaterThan(before);
    expect(row!.expires_at).toBe(git.session.expires_at);
  });

  it("are anonymous on the hub's own API, by bearer or cookie", async () => {
    const { git } = await setup();
    const byBearer = await apiPost("acme.pimwell.test", "whoami", {}, bearer(git.token));
    expect(await byBearer.json()).toEqual({ ok: true, result: { identity: null } });
    const byCookie = await apiPost("acme.pimwell.test", "whoami", {}, cookieHeaders(git.token, "acme.pimwell.test"));
    expect(await byCookie.json()).toEqual({ ok: true, result: { identity: null } });
    expect(byCookie.headers.get("set-cookie") ?? "").toContain("pmw_session=");
    expect((await apiPost("acme.pimwell.test", "session.list", {}, bearer(git.token))).status).toBe(401);
  });
});
