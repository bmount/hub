import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi, afterEach } from "vitest";
import { ArtifactsRest, validationRepository } from "../src/code/artifactsRest";
import { repoOwnership } from "../src/code/artifactPush";
import { buildContext } from "../src/auth/context";
import { tenantDelete } from "../src/verbs/tenant";
import { bearer } from "./helpers";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import type { WakeItem } from "../src/chat/types";
import { inDO } from "./do-helper";
import type { Conversation } from "../src/chat/conversationDO";
afterEach(() => vi.restoreAllMocks());
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
  await createProject(env.HUB_DB, { tenant_id: old.id, namespace_id: null, slug: "tasks", kind: "tracker", display_name: "Tasks" }, Date.now());
  for (const t of [old, keep]) {
    const wiki = await createProject(env.HUB_DB, {tenant_id: t.id, namespace_id: null, slug: "guide", kind: "wiki", display_name: "Guide"}, Date.now());
    await env.HUB_DB.prepare("INSERT INTO wiki_revision (tenant_id, project_id, slug, revision, title, body, links, note, author_id, created_at) VALUES (?, ?, 'start', 1, 'Start', 'Body', '[]', 'Create', ?, ?)").bind(t.id, wiki.id, person.identity.id, Date.now()).run();
  }
  await recordEvent(env.HUB_DB, { tenant_id: old.id, identity_id: person.identity.id, session_id: person.session.id, kind: "x", target_kind: "x", target_id: "x", summary: "old" }, Date.now());
  // An event elsewhere that points at the agent and at its session: it must survive with the links cleared.
  await recordEvent(env.HUB_DB, { tenant_id: keep.id, identity_id: bot.agent.identity.id, session_id: bot.session.id, kind: "x", target_kind: "x", target_id: "x", summary: "keep" }, Date.now());
  return { old, keep, root, person, bot, h: cookieHeaders(root.token, HOST) };
}

describe("tenant.delete", () => {
  it("lets a non-root human create, invite, archive and delete only their own organization", async () => {
    const keep = await seedTenant("keep");
    const human = await seedHuman("creator@example.com", { memberships: [{ tenant_id: keep.id, role: "member" }] });
    const h = cookieHeaders(human.token, HOST);
    const made = await apiPost(HOST, "tenant.create", { slug: "neworg", display_name: "New org" }, h);
    expect(made.status).toBe(200);
    const { result: { tenant } } = await made.json() as { result: { tenant: { id: string } } };
    expect(await env.HUB_DB.prepare("SELECT role FROM membership WHERE tenant_id = ? AND identity_id = ?").bind(tenant.id, human.identity.id).first()).toEqual({ role: "admin" });
    expect((await SELF.fetch("https://neworg.pimwell.test/", { headers: cookieHeaders(human.token, "neworg.pimwell.test") })).status).toBe(200);
    expect((await apiPost("neworg.pimwell.test", "invite.create", { email: "invitee@example.com", role: "member" }, cookieHeaders(human.token, "neworg.pimwell.test"))).status).toBe(200);
    expect((await apiPost(HOST, "tenant.archive", { slug: "keep" }, h)).status).toBe(403);
    expect((await apiPost(HOST, "tenant.delete", { slug: "neworg", confirm: "neworg" }, h)).status).toBe(409);
    expect((await apiPost(HOST, "tenant.archive", { slug: "neworg" }, h)).status).toBe(200);
    const home = await (await SELF.fetch(`https://${HOST}/`, { headers: h })).text();
    expect(home).toContain("Type neworg to delete permanently");
    expect((await apiPost(HOST, "tenant.delete", { slug: "neworg", confirm: "neworg" }, bearer(human.token))).status).toBe(403);
    expect((await apiPost(HOST, "tenant.delete", { slug: "neworg", confirm: "neworg" }, { ...h, origin: "https://evil.test" })).status).toBe(403);
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 600001, human.session.id).run();
    expect((await apiPost(HOST, "tenant.delete", { slug: "neworg", confirm: "neworg" }, h)).status).toBe(403);
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now(), human.session.id).run();
    expect((await apiPost(HOST, "tenant.delete", { slug: "neworg", confirm: "neworg" }, h)).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM invite WHERE tenant_id = ?", tenant.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM tenant WHERE id = ?", keep.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM membership WHERE tenant_id = ?", keep.id)).toBe(1);
  });

  it("refuses agents and anonymous callers, validates slugs and limits creation per identity", async () => {
    const w = await world();
    for (const name of ["tenant.create", "tenant.delete"]) {
      const args = name === "tenant.create" ? { slug: "neworg", display_name: "New" } : { slug: "oldorg", confirm: "oldorg" };
      expect((await apiPost(HOST, name, args, bearer(w.bot.token))).status).not.toBe(200);
      expect((await apiPost("oldorg.pimwell.test", name, args, bearer(w.bot.token))).status).not.toBe(200);
    }
    expect((await apiPost(HOST, "tenant.create", { slug: "anonymous", display_name: "Anon" })).status).toBe(401);
    const h = cookieHeaders(w.person.token, HOST);
    for (const slug of ["admin", "a_b", "Uppercase", "-bad"]) expect((await apiPost(HOST, "tenant.create", { slug, display_name: "Invalid" }, h)).status).toBe(400);
    for (const slug of ["one", "two", "three"]) expect((await apiPost(HOST, "tenant.create", { slug, display_name: slug }, h)).status).toBe(200);
    expect((await apiPost(HOST, "tenant.create", { slug: "four", display_name: "Four" }, h)).status).toBe(429);
    expect((await apiPost(HOST, "tenant.create", { slug: "four", display_name: "Four" }, w.h)).status).toBe(200);
    const signedOut = await (await SELF.fetch(`https://${HOST}/`)).text();
    expect(signedOut).toContain('action="/api/tenant.create"');
    const redirect = await SELF.fetch(`https://${HOST}/api/tenant.create`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: `https://${HOST}` }, body: "slug=test&display_name=Test", redirect: "manual" });
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toBe(`https://${HOST}/login`);
  });

  it("purges only owned repositories, keeps failures archived and retryable, and removes file objects", async () => {
    const w = await world();
    const repo = await createProject(env.HUB_DB, { tenant_id: w.old.id, namespace_id: null, slug: "repo", kind: "repo", display_name: "Repo" }, Date.now());
    await env.HUB_DB.prepare("INSERT INTO git_repository (tenant_id, project_id, imported_at) VALUES (?, ?, ?)").bind(w.old.id, repo.id, Date.now()).run();
    await setTenantState(env.HUB_DB, w.old.id, "archived", Date.now());
    const ctx = await buildContext(new Request(`https://${HOST}/`, { headers: w.h }), env);
    ctx.env = { ...env, ARTIFACTS_ACCOUNT_ID: "0".repeat(32), ARTIFACTS_API_TOKEN: "synthetic-test-token" };
    const del = vi.spyOn(ArtifactsRest.prototype, "deleteProject").mockRejectedValueOnce(new Error("storage outage")).mockResolvedValue(undefined);
    const bucket = env.GIT_PUSH_STAGING!;
    await bucket.put(`project-files/${w.old.id}/x/file`, "old");
    await bucket.put(`project-files/${w.keep.id}/x/file`, "keep");
    const replay = `git-push/${w.old.id}/${repo.id}/cache-test`;
    await bucket.put(replay, "pack");
    await env.HUB_DB.prepare("INSERT INTO git_push (id, tenant_id, project_id, namespace, repo, shadow, replay_key, updates_json, state, created_at) VALUES (?, ?, ?, 'oldorg', 'repo', ?, ?, '[]', 'complete', ?)").bind(crypto.randomUUID(), w.old.id, repo.id, await validationRepository("repo"), replay, Date.now()).run();
    const temporary = vi.spyOn(ArtifactsRest.prototype, "deleteTemporary").mockRejectedValue(new Error("shared cache is not temporary"));
    const args = tenantDelete.parse({ slug: "oldorg", confirm: "oldorg" });
    await expect(tenantDelete.run(ctx, args)).rejects.toThrow("storage outage");
    expect((await apiPost(HOST, "tenant.unarchive", { slug: "oldorg" }, w.h)).status).toBe(409);
    await tenantDelete.run(ctx, args);
    expect(del).toHaveBeenLastCalledWith("oldorg", "repo", repoOwnership(w.old.id, repo.id));
    expect(temporary).not.toHaveBeenCalled();expect(await bucket.get(replay)).toBeNull();
    expect(await bucket.get(`project-files/${w.old.id}/x/file`)).toBeNull();
    expect(await bucket.get(`project-files/${w.keep.id}/x/file`)).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM git_repository WHERE tenant_id = ?", w.old.id)).toBe(0);
  });

  it("refuses an active organization and a wrong confirmation, and changes nothing", async () => {
    const w = await world();
    expect((await apiPost(HOST, "tenant.delete", { slug: "oldorg", confirm: "oldorg" }, w.h)).status).toBe(409);
    await setTenantState(env.HUB_DB, w.old.id, "archived", Date.now());
    expect((await apiPost(HOST, "tenant.delete", { slug: "oldorg", confirm: "old" }, w.h)).status).toBe(400);
    expect(await count("SELECT COUNT(*) AS n FROM tenant WHERE id = ?", w.old.id)).toBe(1);
  });

  it("refuses a non-admin", async () => {
    const w = await world();
    await setTenantState(env.HUB_DB, w.old.id, "archived", Date.now());
    const res = await apiPost(HOST, "tenant.delete", { slug: "oldorg", confirm: "oldorg" }, cookieHeaders(w.person.token, HOST));
    expect(res.status).toBe(403);
    expect(await count("SELECT COUNT(*) AS n FROM tenant WHERE id = ?", w.old.id)).toBe(1);
  });

  it("removes everything for the organization, keeps people who belong elsewhere, and leaves a tombstone", async () => {
    const w = await world();
    await setTenantState(env.HUB_DB, w.old.id, "archived", Date.now());
    for (const t of [w.old, w.keep]) for (const prefix of ["review_request", "mail_actions"]) await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
      .bind(`${prefix}:v1:${t.id}:caller:key`, JSON.stringify({ result: "private snapshot" })).run();
    const res = await apiPost(HOST, "tenant.delete", { slug: "oldorg", confirm: "OldOrg" }, w.h);
    expect(res.status).toBe(200);
    for (const t of ["tenant WHERE id", "membership WHERE tenant_id", "project WHERE tenant_id", "session WHERE tenant_id", "api_token WHERE tenant_id", "event WHERE tenant_id", "wiki_revision WHERE tenant_id"]) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${t} = ?`, w.old.id), t).toBe(0);
    }
    expect(await count("SELECT COUNT(*) AS n FROM meta WHERE key GLOB ?", `review_request:v1:${w.old.id}:*`)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM meta WHERE key GLOB ?", `review_request:v1:${w.keep.id}:*`)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM meta WHERE key GLOB ?", `mail_actions:v1:${w.old.id}:*`)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM meta WHERE key GLOB ?", `mail_actions:v1:${w.keep.id}:*`)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM identity WHERE id = ?", w.bot.agent.identity.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM identity WHERE id = ?", w.person.identity.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM wiki_revision WHERE tenant_id = ?", w.keep.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM membership WHERE tenant_id = ?", w.keep.id)).toBe(1);
    const kept = await env.HUB_DB.prepare("SELECT identity_id, session_id FROM event WHERE tenant_id = ? AND summary = 'keep'").bind(w.keep.id).first();
    expect(kept).toEqual({ identity_id: null, session_id: null });
    const tomb = await env.HUB_DB.prepare("SELECT slug, git_purged_at FROM deleted_tenant WHERE id = ?").bind(w.old.id).first();
    expect(tomb).toEqual({ slug: "oldorg", git_purged_at: null });
    expect(await count("SELECT COUNT(*) AS n FROM event WHERE kind = 'tenant.delete' AND tenant_id IS NULL")).toBe(1);
  });

  it("purges conversation versions and entire tenant inboxes, refusing late delivery", async () => {
    const w = await world();
    const channels = new Map<string, string>();
    for (const t of [w.old, w.keep]) {
      const host = `${t.slug}.${HOST}`;
      expect((await apiPost(host, "channel.create", { slug: "general" }, cookieHeaders(w.root.token, host))).status).toBe(200);
      const channel = await env.HUB_DB.prepare("SELECT project_id FROM channel WHERE tenant_id = ?").bind(t.id).first<{ project_id: string }>();
      channels.set(t.id, channel!.project_id);
      expect((await apiPost(host, "chat.post", { c: "general", body: "Tenant-private message" }, cookieHeaders(w.person.token, host))).status).toBe(200);
      const item: WakeItem = { key: "orphaned-mail", kind: "mail", conversation_id: "mail", seq: 1, msg_id: "mail-not-in-d1", thread_root: null, hop: 0, author_id: w.person.identity.id, wake: true, created_at: Date.now() };
      await inboxStub(env, t.id, w.person.identity.id).deliver(t.id, w.person.identity.id, [item]);
    }
    await setTenantState(env.HUB_DB, w.old.id, "archived", Date.now());
    expect((await apiPost(HOST, "tenant.delete", { slug: "oldorg", confirm: "oldorg" }, w.h)).status).toBe(200);
    const stored = await inDO(conversationStub(env, w.old.id, channels.get(w.old.id)!), (_instance: Conversation, state) => ({
      messages: state.storage.sql.exec("SELECT COUNT(*) AS n FROM artifact").one().n,
      deleted: state.storage.sql.exec("SELECT value FROM meta WHERE key = 'deleted'").one().value,
    }));
    expect(stored.messages).toBe(0);
    expect(Number(stored.deleted)).toBeGreaterThan(0);
    expect(await conversationStub(env, w.keep.id, channels.get(w.keep.id)!).head(w.keep.id, channels.get(w.keep.id)!)).toBeGreaterThan(0);
    const oldBox = inboxStub(env, w.old.id, w.person.identity.id), keepBox = inboxStub(env, w.keep.id, w.person.identity.id);
    expect((await oldBox.list(w.old.id, w.person.identity.id, { after: 0, limit: 100, include_acked: true })).items).toEqual([]);
    expect((await keepBox.list(w.keep.id, w.person.identity.id, { after: 0, limit: 100, include_acked: true })).items.length).toBeGreaterThan(0);
    expect(await oldBox.deliver(w.old.id, w.person.identity.id, [{ key: "late", kind: "mail", conversation_id: "mail", seq: 2, msg_id: "late", thread_root: null, hop: 0, author_id: w.person.identity.id, wake: true, created_at: Date.now() }])).toBe(0);
  });

  it("preserves shared agents and other tenants' graph, proposals and contacts", async () => {
    const w = await world();
    await env.HUB_DB.prepare("INSERT INTO membership (id, identity_id, tenant_id, role, created_at) VALUES ('shared-membership', ?, ?, 'member', ?)").bind(w.bot.agent.identity.id, w.keep.id, Date.now()).run();
    for (const t of [w.old, w.keep]) {
      const project = await env.HUB_DB.prepare("SELECT id FROM project WHERE tenant_id = ? AND kind = 'wiki'").bind(t.id).first<{ id: string }>();
      await env.HUB_DB.prepare("INSERT INTO contact_entity (tenant_id, project_id, id, kind, name, data, updated_at) VALUES (?, ?, 'person', 'person', 'Contact', '{}', ?)").bind(t.id, project!.id, Date.now()).run();
      await env.HUB_DB.prepare("INSERT INTO contact_link (tenant_id, project_id, entity_id, kind, ref) VALUES (?, ?, 'person', 'mail', 'record')").bind(t.id, project!.id).run();
      await env.HUB_DB.prepare("INSERT INTO work_proposal (id, tenant_id, reason, change_json, created_by, created_at) VALUES (?, ?, 'Proposal', '{}', ?, ?)").bind(`proposal-${t.slug}`, t.id, w.person.identity.id, Date.now()).run();
      await env.HUB_DB.prepare("INSERT INTO work_proposal_decision (proposal_id, decision, decided_by, decided_at) VALUES (?, 'rejected', ?, ?)").bind(`proposal-${t.slug}`, w.person.identity.id, Date.now()).run();
      await env.HUB_DB.prepare("INSERT INTO work_graph_rev (tenant_id, rev, created_at) VALUES (?, 1, ?)").bind(t.id, Date.now()).run();
    }
    await setTenantState(env.HUB_DB, w.old.id, "archived", Date.now());
    expect((await apiPost(HOST, "tenant.delete", { slug: "oldorg", confirm: "oldorg" }, w.h)).status).toBe(200);
    for (const table of ["contact_entity", "contact_link", "work_proposal", "work_graph_rev"]) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`, w.old.id)).toBe(0);
      expect(await count(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`, w.keep.id)).toBe(1);
    }
    expect(await count("SELECT COUNT(*) AS n FROM work_proposal_decision")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM identity WHERE id = ?", w.bot.agent.identity.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM membership WHERE identity_id = ? AND tenant_id = ?", w.bot.agent.identity.id, w.keep.id)).toBe(1);
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
