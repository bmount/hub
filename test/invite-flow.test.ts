import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { getIdentityByEmail } from "../src/db/identities";
import { getMembership } from "../src/db/memberships";
import { admitGoogle } from "../src/auth/googleAdmit";

async function makeInvite(role = "member") {
  const t = await seedTenant("acme");
  const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
  const res = await apiPost("acme.pimwell.test", "invite.create", { email: "new@example.com", role, display_name: "New Person" }, bearer(admin.token));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { invite_url: string; invite_id: string } };
  return { t, admin, url: body.result.invite_url, invite_id: body.result.invite_id };
}

describe("invite verbs", () => {
  it("admin creates an apex invite link, lists it, revokes it", async () => {
    const { admin, url, invite_id } = await makeInvite();
    expect(url).toMatch(/^https:\/\/pimwell\.test\/invite\/pmi_/);
    const list = (await (await apiPost("acme.pimwell.test", "invite.list", {}, bearer(admin.token))).json()) as any;
    expect(list.result.invites).toHaveLength(1);
    expect(list.result.invites[0].status).toBe("open");
    expect(JSON.stringify(list)).not.toContain("token_hash");
    expect((await apiPost("acme.pimwell.test", "invite.revoke", { invite_id }, bearer(admin.token))).status).toBe(200);
    expect((await apiPost("acme.pimwell.test", "invite.revoke", { invite_id }, bearer(admin.token))).status).toBe(409);
    const after = (await (await apiPost("acme.pimwell.test", "invite.list", {}, bearer(admin.token))).json()) as any;
    expect(after.result.invites[0].status).toBe("revoked");
  });

  it("members cannot invite; admins cannot invite roots", async () => {
    const t = await seedTenant("acme");
    const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    expect((await apiPost("acme.pimwell.test", "invite.create", { email: "x@example.com", role: "member" }, bearer(member.token))).status).toBe(403);
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    expect((await apiPost("acme.pimwell.test", "invite.create", { email: "x@example.com", role: "root" }, bearer(admin.token))).status).toBe(400);
  });

  it("rejects inviting an email that is already an active member", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    await seedHuman("m@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const res = await apiPost("acme.pimwell.test", "invite.create", { email: "m@example.com", role: "reader" }, bearer(admin.token));
    expect(res.status).toBe(409);
  });

  it("still requires independent verification when membership appeared after the invite was made", async () => {
    const { t, url } = await makeInvite();
    await seedHuman("new@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const post = await SELF.fetch(url, { method: "POST", redirect: "manual", headers: { origin: "https://pimwell.test" } });
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("Verify your invited address");
  });

  it("another tenant's admin cannot revoke the invite", async () => {
    const { invite_id } = await makeInvite();
    const blue = await seedTenant("blue");
    const other = await seedHuman("b@example.com", { memberships: [{ tenant_id: blue.id, role: "admin" }] });
    expect((await apiPost("blue.pimwell.test", "invite.revoke", { invite_id }, bearer(other.token))).status).toBe(404);
  });
});

describe("invite acceptance page", () => {
  it("GET and legacy POST show exact-address verification without consuming or signing in", async () => {
    const { url } = await makeInvite();
    for (const method of ["GET", "POST"]) {
      const res = await SELF.fetch(url, { method, redirect: "manual", headers: { origin: "https://pimwell.test" } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("ACME");
      expect(html).toContain("new@example.com");
      expect(html).toContain('href="/login/google?next=acme"');
      expect(html).not.toContain("<form");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await getIdentityByEmail(env.HUB_DB, "new@example.com")).toBeNull();
    }
  });

  it("repeated/concurrent legacy POSTs create no sessions and leave the invite open", async () => {
    const { url, invite_id } = await makeInvite();
    const headers = { origin: "https://pimwell.test" };
    const responses = await Promise.all(Array.from({ length: 3 }, () => SELF.fetch(url, { method: "POST", redirect: "manual", headers })));
    expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
    expect(responses.every(r => !r.headers.get("set-cookie"))).toBe(true);
    expect((await env.HUB_DB.prepare("SELECT accepted_at FROM invite WHERE id = ?").bind(invite_id).first<any>()).accepted_at).toBeNull();
    const sessions = await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM session").first<{ n: number }>();
    expect(sessions?.n).toBe(1);
  });

  it("bad tokens, wrong hosts, and bad origins", async () => {
    const { url } = await makeInvite();
    const bogus = await SELF.fetch("https://pimwell.test/invite/pmi_bogus");
    expect(bogus.status).toBe(200);
    expect(await bogus.text()).toContain("not valid");
    expect((await SELF.fetch(url.replace("https://pimwell.test", "https://acme.pimwell.test"))).status).toBe(404);
    expect((await SELF.fetch(url, { method: "POST", redirect: "manual" })).status).toBe(403);
  });

  it("a root invite cannot create or promote an identity from a bearer POST", async () => {
    const res = await apiPost("pimwell.test", "bootstrap", { token: "test-bootstrap-token", email: "r@example.com", display_name: "Root" });
    const url = ((await res.json()) as any).result.invite_url as string;
    const post = await SELF.fetch(url, { method: "POST", redirect: "manual", headers: { origin: "https://pimwell.test" } });
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("Verify your invited address");
    expect(post.headers.get("set-cookie")).toBeNull();
    expect(await getIdentityByEmail(env.HUB_DB, "r@example.com")).toBeNull();
  });
});

async function sessionCount(identity_id: string): Promise<number> {
  return (await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM session WHERE identity_id = ?").bind(identity_id).first<{ n: number }>())!.n;
}

async function inviteFor(email: string) {
  const t = await seedTenant("acme");
  const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
  const res = await apiPost("acme.pimwell.test", "invite.create", { email, role: "member" }, bearer(admin.token));
  return { t, admin, url: ((await res.json()) as any).result.invite_url as string };
}

describe("invites for existing identities", () => {
  it("anonymous bearer POST adds no membership, session or cookie", async () => {
    const victim = await seedHuman("victim@example.com");
    const { t, url } = await inviteFor("victim@example.com");
    const post = await SELF.fetch(url, { method: "POST", redirect: "manual", headers: { origin: "https://pimwell.test" } });
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("Verify your invited address");
    expect(post.headers.get("set-cookie")).toBeNull();
    expect(await getMembership(env.HUB_DB, victim.identity.id, t.id)).toBeNull();
    expect(await sessionCount(victim.identity.id)).toBe(1);
  });

  it("the identity's legacy session cannot substitute for independent proof", async () => {
    const victim = await seedHuman("victim@example.com");
    const { t, url } = await inviteFor("victim@example.com");
    const post = await SELF.fetch(url, { method: "POST", redirect: "manual", headers: cookieHeaders(victim.token, "pimwell.test") });
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("Verify your invited address");
    expect(post.headers.get("set-cookie")).toBeNull();
    expect(await getMembership(env.HUB_DB, victim.identity.id, t.id)).toBeNull();
  });

  it("a root invite for an existing identity cannot promote without independent proof", async () => {
    const existing = await seedHuman("r@example.com");
    const res = await apiPost("pimwell.test", "bootstrap", { token: "test-bootstrap-token", email: "r@example.com", display_name: "Root" });
    const url = ((await res.json()) as any).result.invite_url as string;
    const post = await SELF.fetch(url, { method: "POST", redirect: "manual", headers: { origin: "https://pimwell.test" } });
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("Verify your invited address");
    expect(post.headers.get("set-cookie")).toBeNull();
    expect((await getIdentityByEmail(env.HUB_DB, "r@example.com"))?.is_root).toBe(0);
    expect(await sessionCount(existing.identity.id)).toBe(1);
  });
});

describe("invite policy", () => {
  it("only roots may invite admins", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    expect((await apiPost("acme.pimwell.test", "invite.create", { email: "x@example.com", role: "admin" }, bearer(admin.token))).status).toBe(403);
    const root = await seedHuman("r@example.com", { is_root: true });
    expect((await apiPost("acme.pimwell.test", "invite.create", { email: "x@example.com", role: "admin" }, bearer(root.token))).status).toBe(200);
  });

  it("revoking an accepted invite is a conflict", async () => {
    const { admin, invite_id, url } = await makeInvite();
    const admission = await admitGoogle(env.HUB_DB, { sub: "new-sub", email: "new@example.com", email_verified: true }, Date.now(), "pimwell.test");
    expect(admission.ok).toBe(true);
    expect(await (await SELF.fetch(url)).text()).toContain("not valid");
    expect((await apiPost("acme.pimwell.test", "invite.revoke", { invite_id }, bearer(admin.token))).status).toBe(409);
  });
});
