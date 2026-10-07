// One name space per organization: a project and a helper can never share a name (mailboxes spec, amendment
// 2026-10-07 b), so <org>.<name>@pimwell.com can only ever mean one of them. First come, first served.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { createAgent } from "../src/db/agents";
import { seedHuman, seedTenant } from "./helpers";

async function world() {
  const t = await seedTenant("acme");
  const other = await seedTenant("other");
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }, { tenant_id: other.id, role: "admin" }] });
  const helper = (tenant: typeof t, slug: string) => createAgent(env.HUB_DB, { tenant, slug, display_name: slug, operator_id: pat.identity.id, role: "member", hubDomain: env.HUB_DOMAIN }, Date.now());
  const project = (tenant: typeof t, slug: string) => createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug, kind: "repo", display_name: slug }, Date.now());
  return { t, other, helper, project };
}

describe("projects and helpers share one name space", () => {
  it("refuses a project named after a helper in the same organization", async () => {
    const w = await world();
    await w.helper(w.t, "scout");
    await expect(w.project(w.t, "scout")).rejects.toThrow(/name of a helper/);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM project WHERE slug = 'scout'").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("refuses a helper named after a project, and leaves no half-made helper behind", async () => {
    const w = await world();
    await w.project(w.t, "site");
    await expect(w.helper(w.t, "site")).rejects.toThrow(/name of a project/);
    const left = await env.HUB_DB.prepare("SELECT (SELECT COUNT(*) FROM identity WHERE kind = 'agent') AS i, (SELECT COUNT(*) FROM membership m JOIN identity x ON x.id = m.identity_id WHERE x.kind = 'agent') AS m").first();
    expect(left).toEqual({ i: 0, m: 0 });
  });

  it("keeps a helper's name taken after it is archived", async () => {
    const w = await world();
    const a = await w.helper(w.t, "scout");
    await env.HUB_DB.prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(a.identity.id).run();
    await expect(w.project(w.t, "scout")).rejects.toThrow(/name of a helper/);
  });

  it("lets other organizations use the same name, and channels do not hold names", async () => {
    const w = await world();
    await w.helper(w.t, "scout");
    await expect(w.project(w.other, "scout")).resolves.toMatchObject({ slug: "scout" });
    // Channels are not addressable by mail, so a channel's name does not hold a helper's name.
    await env.HUB_DB.prepare("INSERT INTO project (id, tenant_id, namespace_id, slug, kind, display_name, state, created_at) VALUES ('CH1', ?, NULL, 'general', 'channel', 'General', 'active', 0)").bind(w.t.id).run();
    await expect(w.helper(w.t, "general")).resolves.toMatchObject({ slug: "general" });
  });
});
