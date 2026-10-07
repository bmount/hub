// People management (2026-10-07): admins invite, change roles and remove people; only a root touches admin.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { findInviteByToken, acceptInvite } from "../src/db/invites";
import { apiPost, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";

async function world() {
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const root = await seedHuman("root@example.com", { is_root: true });
  const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
  const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const lee = await seedHuman("lee@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
  await seedAgent(t, ada.identity, "scout");
  const as = (h: { token: string }) => (verb: string, body: unknown) => apiPost(HOST, verb, body, cookieHeaders(h.token, HOST));
  const get = (path: string, token: string) => SELF.fetch(`https://${HOST}${path}`, { headers: cookieHeaders(token, HOST) });
  return { t, root, ada, sam, lee, as, get };
}
const status = async (r: Promise<Response>) => (await r).status;

describe("people management", () => {
  it("shows admins the invite form and pending invites, and members neither", async () => {
    const w = await world();
    const adminPage = await (await w.get("/people", w.ada.token)).text();
    expect(adminPage).toContain('href="/people?invite=1"');
    expect(adminPage).toContain("<h2>Invites waiting</h2>");
    const form = await (await w.get("/people?invite=1", w.ada.token)).text();
    expect(form).toContain('action="/api/invite.create"');
    expect(form).not.toContain('value="admin"');
    expect(await (await w.get("/people?invite=1", w.root.token)).text()).toContain('value="admin"');
    const memberPage = await (await w.get("/people", w.sam.token)).text();
    expect(memberPage).not.toContain("Invite someone");
    expect(memberPage).not.toContain("Invites waiting");
  });

  it("creates an invite from the form, shows its link once, and lists it until revoked", async () => {
    const w = await world();
    const res = await SELF.fetch(`https://${HOST}/api/invite.create`, {
      method: "POST", headers: { ...cookieHeaders(w.ada.token, HOST), origin: `https://${HOST}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "new@example.com", display_name: "New", role: "member", _back: "/people" }).toString(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/value="https:\/\/pimwell\.test\/invite\/[^"]+"/);
    expect(await (await w.get("/people", w.ada.token)).text()).toContain("<code>new@example.com</code>");
  });

  it("changes roles within the rules: admins manage members and readers, only root touches admin, nobody changes themselves", async () => {
    const w = await world();
    expect(await status(w.as(w.ada)("member.set_role", { email: "sam@example.com", role: "reader" }))).toBe(200);
    expect((await env.HUB_DB.prepare("SELECT m.role FROM membership m JOIN identity i ON i.id = m.identity_id WHERE i.email = 'sam@example.com'").first<{ role: string }>())!.role).toBe("reader");
    expect(await status(w.as(w.ada)("member.set_role", { email: "sam@example.com", role: "admin" }))).toBe(403);
    expect(await status(w.as(w.ada)("member.set_role", { email: "lee@example.com", role: "member" }))).toBe(403);
    expect(await status(w.as(w.ada)("member.set_role", { email: "ada@example.com", role: "member" }))).toBe(400);
    expect(await status(w.as(w.ada)("member.set_role", { email: "scout@acme.pimwell.test", role: "reader" }))).toBe(400);
    expect(await status(w.as(w.sam)("member.set_role", { email: "lee@example.com", role: "reader" }))).toBe(403);
    expect(await status(w.as(w.root)("member.set_role", { email: "lee@example.com", role: "member" }))).toBe(200);
    const ev = await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'member.set_role'").first<{ n: number }>();
    expect(ev!.n).toBe(2);
  });

  it("removes a person: access ends, open work is unassigned, and a new invite brings them back", async () => {
    const w = await world();
    await w.as(w.sam)("work.create", { project: "site", kind: "errand", title: "Mine", owner: "me" });
    expect(await status(w.as(w.ada)("member.remove", { email: "sam@example.com", confirm: "wrong@example.com" }))).toBe(400);
    expect(await status(w.as(w.ada)("member.remove", { email: "sam@example.com", confirm: "sam@example.com" }))).toBe(200);
    expect((await w.get("/docket", w.sam.token)).status).toBe(404);
    expect((await env.HUB_DB.prepare("SELECT owner_id FROM work_item WHERE title = 'Mine'").first<{ owner_id: string | null }>())!.owner_id).toBeNull();
    const created = await (await w.as(w.ada)("invite.create", { email: "sam@example.com", role: "reader" })).json() as { result: { invite_url: string } };
    const invite = await findInviteByToken(env.HUB_DB, created.result.invite_url.split("/invite/")[1]!);
    await acceptInvite(env.HUB_DB, invite!, Date.now());
    const m = await env.HUB_DB.prepare("SELECT m.role, m.state FROM membership m JOIN identity i ON i.id = m.identity_id WHERE i.email = 'sam@example.com'").first();
    expect(m).toEqual({ role: "reader", state: "active" });
  });

  it("shows a person in the inspector with their work and activity, and management only to admins", async () => {
    const w = await world();
    const page = await (await w.get("/people/sam%40example.com", w.ada.token)).text();
    expect(page).toContain("<h1>sam</h1>");
    expect(page).toContain('action="/api/member.set_role"');
    expect(page).toContain('href="/docket?owner=sam%40example.com"');
    expect(await (await w.get("/people/sam%40example.com", w.sam.token)).text()).not.toContain("member.set_role");
    expect((await w.get("/people/nobody%40example.com", w.ada.token)).status).toBe(404);
  });
});
