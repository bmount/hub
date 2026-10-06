import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { getIdentityByEmail } from "../src/db/identities";
import { getMembership } from "../src/db/memberships";
import { listEvents } from "../src/db/events";

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

  it("another tenant's admin cannot revoke the invite", async () => {
    const { invite_id } = await makeInvite();
    const blue = await seedTenant("blue");
    const other = await seedHuman("b@example.com", { memberships: [{ tenant_id: blue.id, role: "admin" }] });
    expect((await apiPost("blue.pimwell.test", "invite.revoke", { invite_id }, bearer(other.token))).status).toBe(404);
  });
});

describe("invite acceptance page", () => {
  it("GET shows the tenant and a button without consuming; POST creates identity, membership, session", async () => {
    const { t, url } = await makeInvite();
    const get = await SELF.fetch(url);
    expect(get.status).toBe(200);
    const html = await get.text();
    expect(html).toContain("ACME");
    expect(html).toContain("<form");
    expect(await getIdentityByEmail(env.HUB_DB, "new@example.com")).toBeNull();

    const post = await SELF.fetch(url, { method: "POST", redirect: "manual", headers: { origin: "https://pimwell.test" } });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("https://acme.pimwell.test/");
    const cookie = post.headers.get("set-cookie")!;
    expect(cookie).toContain("pmw_session=pms_");
    const identity = await getIdentityByEmail(env.HUB_DB, "new@example.com");
    expect(identity?.display_name).toBe("New Person");
    expect((await getMembership(env.HUB_DB, identity!.id, t.id))?.role).toBe("member");
    const events = await listEvents(env.HUB_DB, t.id, 5);
    expect(events[0]!.kind).toBe("invite.accept");
    expect(events[0]!.identity_id).toBe(identity!.id);

    const token = cookie.split(";")[0]!.split("=")[1]!;
    const who = (await (await apiPost("acme.pimwell.test", "whoami", {}, cookieHeaders(token, "acme.pimwell.test"))).json()) as any;
    expect(who.result.tenant.role).toBe("member");
  });

  it("second POST and concurrent POSTs yield exactly one session", async () => {
    const { url } = await makeInvite();
    const headers = { origin: "https://pimwell.test" };
    const [a, b] = await Promise.all([
      SELF.fetch(url, { method: "POST", redirect: "manual", headers }),
      SELF.fetch(url, { method: "POST", redirect: "manual", headers }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 303]);
    const again = await SELF.fetch(url, { method: "POST", redirect: "manual", headers });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("not valid");
    const sessions = await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM session").first<{ n: number }>();
    expect(sessions?.n).toBe(2);
  });

  it("bad tokens, wrong hosts, and bad origins", async () => {
    const { url } = await makeInvite();
    const bogus = await SELF.fetch("https://pimwell.test/invite/pmi_bogus");
    expect(bogus.status).toBe(200);
    expect(await bogus.text()).toContain("not valid");
    expect((await SELF.fetch(url.replace("https://pimwell.test", "https://acme.pimwell.test"))).status).toBe(404);
    expect((await SELF.fetch(url, { method: "POST", redirect: "manual" })).status).toBe(403);
  });

  it("a root invite lands on the apex", async () => {
    const res = await apiPost("pimwell.test", "bootstrap", { token: "test-bootstrap-token", email: "r@example.com", display_name: "Root" });
    const url = ((await res.json()) as any).result.invite_url as string;
    const post = await SELF.fetch(url, { method: "POST", redirect: "manual", headers: { origin: "https://pimwell.test" } });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("https://pimwell.test/");
    expect((await getIdentityByEmail(env.HUB_DB, "r@example.com"))?.is_root).toBe(1);
  });
});
