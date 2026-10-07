import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";
import { createProject } from "../src/db/projects";
import { recordEvent } from "../src/db/events";
import { setTenantState } from "../src/db/tenants";

const HOST = "pimwell.test";
const count = async (sql: string, ...b: unknown[]) => (await env.HUB_DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;

async function world() {
  const old = await seedTenant("oldorg"), keep = await seedTenant("keeporg");
  const root = await seedHuman("root@example.com", { is_root: true });
  const person = await seedHuman("person@example.com", { memberships: [{ tenant_id: old.id, role: "member" }, { tenant_id: keep.id, role: "member" }] });
  const bot = await seedAgent(old, person.identity, "bot");
  await createProject(env.HUB_DB, { tenant_id: old.id, namespace_id: null, slug: "repo", kind: "repo", display_name: "Repo" }, Date.now());
  await recordEvent(env.HUB_DB, { tenant_id: old.id, identity_id: person.identity.id, session_id: person.session.id, kind: "x", target_kind: "x", target_id: "x", summary: "old" }, Date.now());
  // An event elsewhere that points at the agent and at its session: it must survive with the links cleared.
  await recordEvent(env.HUB_DB, { tenant_id: keep.id, identity_id: bot.agent.identity.id, session_id: bot.session.id, kind: "x", target_kind: "x", target_id: "x", summary: "keep" }, Date.now());
  return { old, keep, root, person, bot, h: cookieHeaders(root.token, HOST) };
}

describe("tenant.delete", () => {
  it("refuses an active organization and a wrong confirmation, and changes nothing", async () => {
    const w = await world();
    expect((await apiPost(HOST, "tenant.delete", { slug: "oldorg", confirm: "oldorg" }, w.h)).status).toBe(409);
    await setTenantState(env.HUB_DB, w.old.id, "archived", Date.now());
    expect((await apiPost(HOST, "tenant.delete", { slug: "oldorg", confirm: "old" }, w.h)).status).toBe(400);
    expect(await count("SELECT COUNT(*) AS n FROM tenant WHERE id = ?", w.old.id)).toBe(1);
  });

  it("is for root only", async () => {
    const w = await world();
    await setTenantState(env.HUB_DB, w.old.id, "archived", Date.now());
    const res = await apiPost(HOST, "tenant.delete", { slug: "oldorg", confirm: "oldorg" }, cookieHeaders(w.person.token, HOST));
    expect(res.status).toBe(403);
    expect(await count("SELECT COUNT(*) AS n FROM tenant WHERE id = ?", w.old.id)).toBe(1);
  });

  it("removes everything for the organization, keeps people who belong elsewhere, and leaves a tombstone", async () => {
    const w = await world();
    await setTenantState(env.HUB_DB, w.old.id, "archived", Date.now());
    const res = await apiPost(HOST, "tenant.delete", { slug: "oldorg", confirm: "OldOrg" }, w.h);
    expect(res.status).toBe(200);
    for (const t of ["tenant WHERE id", "membership WHERE tenant_id", "project WHERE tenant_id", "session WHERE tenant_id", "api_token WHERE tenant_id", "event WHERE tenant_id"]) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${t} = ?`, w.old.id), t).toBe(0);
    }
    expect(await count("SELECT COUNT(*) AS n FROM identity WHERE id = ?", w.bot.agent.identity.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM identity WHERE id = ?", w.person.identity.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM membership WHERE tenant_id = ?", w.keep.id)).toBe(1);
    const kept = await env.HUB_DB.prepare("SELECT identity_id, session_id FROM event WHERE tenant_id = ? AND summary = 'keep'").bind(w.keep.id).first();
    expect(kept).toEqual({ identity_id: null, session_id: null });
    const tomb = await env.HUB_DB.prepare("SELECT slug, git_purged_at FROM deleted_tenant WHERE id = ?").bind(w.old.id).first();
    expect(tomb).toEqual({ slug: "oldorg", git_purged_at: null });
    expect(await count("SELECT COUNT(*) AS n FROM event WHERE kind = 'tenant.delete' AND tenant_id IS NULL")).toBe(1);
  });

  it("keeps the name reserved after deletion", async () => {
    const w = await world();
    await setTenantState(env.HUB_DB, w.old.id, "archived", Date.now());
    await apiPost(HOST, "tenant.delete", { slug: "oldorg", confirm: "oldorg" }, w.h);
    const again = await apiPost(HOST, "tenant.create", { slug: "oldorg", display_name: "Again" }, w.h);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("stays reserved");
  });

  it("lists organizations with a delete control only for archived ones", async () => {
    const w = await world();
    await setTenantState(env.HUB_DB, w.old.id, "archived", Date.now());
    const html = await (await SELF.fetch(`https://${HOST}/admin/orgs`, { headers: w.h })).text();
    expect(html).toContain('placeholder="type oldorg to delete"');
    expect(html).not.toContain('placeholder="type keeporg to delete"');
    expect((await SELF.fetch(`https://${HOST}/admin/orgs`, { headers: cookieHeaders(w.person.token, HOST) })).status).toBe(404);
  });
});
