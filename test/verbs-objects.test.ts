import { env, SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";
import { listEvents } from "../src/db/events";
import { getTenantBySlug } from "../src/db/tenants";
import { buildContext } from "../src/auth/context";
import { callTool } from "../src/mcp/tools";
import { wikiMarkdown } from "../src/http/wikiPages";
import type { Conversation } from "../src/chat/conversationDO";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { projectDelete, projectCreate } from "../src/verbs/project";
import { ArtifactsRest } from "../src/code/artifactsRest";
import { vi } from "vitest";

describe("tenant verbs", () => {
  it("root creates, lists, archives and unarchives a tenant from the apex", async () => {
    const root = await seedHuman("r@example.com", { is_root: true });
    const made = await apiPost("pimwell.test", "tenant.create", { slug: "acme", display_name: "Acme" }, bearer(root.token));
    expect(made.status).toBe(200);
    const list = await apiPost("pimwell.test", "tenant.list", {}, bearer(root.token));
    expect(((await list.json()) as any).result.tenants.map((t: any) => t.slug)).toEqual(["acme"]);
    expect((await apiPost("pimwell.test", "tenant.archive", { slug: "acme" }, bearer(root.token))).status).toBe(200);
    expect((await apiPost("pimwell.test", "tenant.archive", { slug: "acme" }, bearer(root.token))).status).toBe(409);
    expect((await apiPost("pimwell.test", "tenant.archive", { slug: "nope" }, bearer(root.token))).status).toBe(404);
    expect((await getTenantBySlug(env.HUB_DB, "acme"))?.state).toBe("archived");
    expect((await apiPost("pimwell.test", "tenant.unarchive", { slug: "acme" }, bearer(root.token))).status).toBe(200);
    const t = await getTenantBySlug(env.HUB_DB, "acme");
    const events = await listEvents(env.HUB_DB, t!.id, 10);
    expect(events.map((e) => e.kind)).toEqual(["tenant.unarchive", "tenant.archive", "tenant.create"]);
    expect(events[0]!.identity_id).toBe(root.identity.id);
    expect(events[0]!.session_id).toBe(root.session.id);
  });

  it("non-root cannot create tenants; tenant verbs are not served on a tenant host", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    expect((await apiPost("pimwell.test", "tenant.create", { slug: "blue", display_name: "Blue" }, bearer(admin.token))).status).toBe(200);
    const root = await seedHuman("r@example.com", { is_root: true });
    expect((await apiPost("acme.pimwell.test", "tenant.create", { slug: "blue", display_name: "Blue" }, bearer(root.token))).status).toBe(404);
  });
});

describe("namespace and project verbs", () => {
  it("admin creates a namespace, member creates projects, reader lists", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const reader = await seedHuman("v@example.com", { memberships: [{ tenant_id: t.id, role: "reader" }] });

    expect((await apiPost("acme.pimwell.test", "namespace.create", { slug: "research", display_name: "Research" }, bearer(member.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "namespace.create", { slug: "research", display_name: "Research" }, bearer(admin.token))).status).toBe(200);

    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(reader.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(member.token))).status).toBe(200);
    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "site", kind: "repo", display_name: "R Site", namespace: "research" }, bearer(member.token))).status).toBe(200);
    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "x", kind: "repo", display_name: "X", namespace: "missing" }, bearer(member.token))).status).toBe(409);
    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "research", kind: "repo", display_name: "Clash" }, bearer(member.token))).status).toBe(409);

    const list = await apiPost("acme.pimwell.test", "project.list", {}, bearer(reader.token));
    const body = (await list.json()) as any;
    expect(body.result.namespaces.map((n: any) => n.slug)).toEqual(["research"]);
    expect(body.result.projects.map((p: any) => p.path)).toEqual(["research/site", "site"]);
  });

  it("archiving a namespace hides its projects; archive is admin only", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    await apiPost("acme.pimwell.test", "namespace.create", { slug: "research", display_name: "Research" }, bearer(admin.token));
    await apiPost("acme.pimwell.test", "project.create", { slug: "a", kind: "repo", display_name: "A", namespace: "research" }, bearer(member.token));
    await apiPost("acme.pimwell.test", "project.create", { slug: "b", kind: "repo", display_name: "B" }, bearer(member.token));
    expect((await apiPost("acme.pimwell.test", "project.archive", { slug: "b" }, bearer(member.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "namespace.archive", { slug: "research" }, bearer(admin.token))).status).toBe(200);
    const active = (await (await apiPost("acme.pimwell.test", "project.list", {}, bearer(member.token))).json()) as any;
    expect(active.result.projects.map((p: any) => p.path)).toEqual(["b"]);
    const archived = (await (await apiPost("acme.pimwell.test", "project.list", { state: "archived" }, bearer(member.token))).json()) as any;
    expect(archived.result.projects.map((p: any) => p.path)).toEqual(["research/a"]);
    expect((await apiPost("acme.pimwell.test", "project.archive", { slug: "a", namespace: "research" }, bearer(admin.token))).status).toBe(409);
    expect((await apiPost("acme.pimwell.test", "project.unarchive", { slug: "a", namespace: "research" }, bearer(admin.token))).status).toBe(200);
  });
});

describe("wiki pages", () => {
  async function world() {
    const tenant = await seedTenant("acme");
    const member = await seedHuman("writer@example.com", {memberships: [{tenant_id: tenant.id, role: "member"}]});
    const admin = await seedHuman("admin@example.com", {memberships: [{tenant_id: tenant.id, role: "admin"}]});
    const reader = await seedHuman("reader@example.com", {memberships: [{tenant_id: tenant.id, role: "reader"}]});
    const host = "acme.pimwell.test";
    const post = (verb: string, args: unknown, token = member.token) => apiPost(host, verb, args, bearer(token));
    expect((await post("project.create", {slug: "guide", kind: "wiki", display_name: "Guide"})).status).toBe(200);
    const write = (slug: string, body: string, expected_revision = 0) => post("wiki.write", {project: "guide", slug, title: slug, body, expected_revision, note: "A revision"});
    return {tenant, member, admin, reader, host, post, write};
  }
  it("writes, links, searches and reverts with full immutable history over API and MCP", async () => {
    const w = await world();
    expect((await w.write("start", "galactic needle **safe** [[target]] <script>bad()</script>")).status).toBe(200);
    await w.write("target", "destination");
    const target = (await (await w.post("wiki.read", {project: "guide", slug: "target"})).json()) as any;
    expect(target.result.backlinks).toEqual([{slug: "start", title: "start"}]);
    const search = (await (await w.post("search.query", {q: "galactic needle"})).json()) as any;
    expect(search.result.wiki[0].href).toBe("/guide/wiki/start");
    const ctx = await buildContext(new Request("https://" + w.host + "/agent/mcp", {headers: bearer(w.member.token)}), env);
    ctx.playground = {scopes: ["read", "write"]};
    const old = await callTool(ctx, "wiki_read", {project: "guide", slug: "start", revision: 1});
    expect(old.isError).toBeUndefined();
    expect((await callTool(ctx, "wiki_write", {project: "guide", slug: "start", title: "Changed", body: "new text", expected_revision: 1, note: "Change"})).isError).toBeUndefined();
    const original = (old.structuredContent as any).page;
    expect((await callTool(ctx, "wiki_write", {project: "guide", slug: "start", title: original.title, body: original.body, expected_revision: 2, note: "Revert to 1"})).isError).toBeUndefined();
    const history = await callTool(ctx, "wiki_history", {project: "guide", slug: "start"});
    expect((history.structuredContent as any).history.map((r: any) => r.revision)).toEqual([3, 2, 1]);
    expect((history.structuredContent as any).history[0].author).toBe("writer");
    const list = await callTool(ctx, "wiki_list", {project: "guide"});
    expect((list.structuredContent as any).pages.map((r: any) => r.slug)).toEqual(["start", "target"]);
    expect((await (await w.post("wiki.read", {project: "guide", slug: "start", revision: 2})).json() as any).result.page.body).toBe("new text");
  });
  it("refuses stale edits including simultaneous writes, deletion and recreation", async () => {
    const w = await world();
    expect((await Promise.all([w.write("race", "first"), w.write("race", "second")])).map(r => r.status).sort()).toEqual([200, 409]);
    expect((await w.write("race", "stale", 0)).status).toBe(409);
    expect((await Promise.all([w.write("race", "third", 1), w.write("race", "fourth", 1)])).map(r => r.status).sort()).toEqual([200, 409]);
    expect((await w.post("wiki.write", {project: "guide", slug: "race", title: "race", body: "missing revision", note: "oops"})).status).toBe(400);
    expect((await w.post("wiki.delete", {project: "guide", slug: "race", expected_revision: 2, note: "Remove"})).status).toBe(403);
    expect((await w.post("wiki.delete", {project: "guide", slug: "race", expected_revision: 1, note: "Stale"}, w.admin.token)).status).toBe(409);
    expect((await w.post("wiki.delete", {project: "guide", slug: "race", expected_revision: 2, note: "Remove"}, w.admin.token)).status).toBe(200);
    expect((await w.post("wiki.read", {project: "guide", slug: "race"})).status).toBe(404);
    expect((await w.write("race", "cannot reset", 0)).status).toBe(409);
    expect((await w.post("wiki.read", {project: "guide", slug: "race", revision: 1})).status).toBe(200);
    expect((await w.write("race", "restored", 3)).status).toBe(200);
    const context = async (token: string) => {
      const ctx = await buildContext(new Request("https://" + w.host + "/playground", {headers: bearer(token)}), env);
      ctx.playground = {scopes: ["read", "write"]}; return ctx;
    };
    expect((await callTool(await context(w.member.token), "wiki_delete", {project: "guide", slug: "race", expected_revision: 4, note: "Denied"})).isError).toBe(true);
    const admin = await context(w.admin.token);
    admin.playground = {scopes: ["read"]};
    expect((await callTool(admin, "wiki_delete", {project: "guide", slug: "race", expected_revision: 4, note: "Denied"})).isError).toBe(true);
    admin.playground = {scopes: ["write"]};
    expect((await callTool(admin, "wiki_delete", {project: "guide", slug: "race", expected_revision: 4, note: "Remove"})).isError).toBeUndefined();
    expect((await (await w.post("wiki.list", {project: "guide"})).json() as any).result.pages).toEqual([]);
    expect((await (await w.post("search.query", {q: "restored"})).json() as any).result.wiki).toEqual([]);
  });
  it("isolates tenants and projects, gates readers and rejects oversized UTF-8 bodies", async () => {
    const w = await world();
    await w.write("secret", "tenant-only needle [[target]]");
    const blue = await seedTenant("blue");
    const outsider = await seedHuman("blue@example.com", {memberships: [{tenant_id: blue.id, role: "admin"}]});
    const foreign = (verb: string, args: unknown) => apiPost("blue.pimwell.test", verb, args, bearer(outsider.token));
    await foreign("project.create", {slug: "guide", kind: "wiki", display_name: "Guide"});
    for (const verb of ["wiki.read", "wiki.list", "wiki.history"]) {
      expect(JSON.stringify(await (await foreign(verb, {project: "guide", slug: "secret"})).json())).not.toContain("tenant-only");
    }
    expect(JSON.stringify(await (await foreign("search.query", {q: "tenant-only"})).json())).not.toContain("tenant-only needle");
    expect((await foreign("wiki.write", {project: "guide", slug: "secret", title: "Foreign", body: "", note: "Foreign", expected_revision: 1})).status).toBe(409);
    expect((await foreign("wiki.delete", {project: "guide", slug: "secret", note: "Foreign", expected_revision: 1})).status).toBe(404);
    expect((await w.post("wiki.write", {project: "guide", slug: "secret", title: "No", body: "", note: "No", expected_revision: 1}, w.reader.token)).status).toBe(403);
    expect((await w.write("huge", "é".repeat(65537))).status).toBe(400);
    await w.post("project.create", {slug: "other", kind: "wiki", display_name: "Other"});
    expect((await w.post("wiki.read", {project: "other", slug: "secret"})).status).toBe(404);
    await w.post("project.create", {slug: "tracker", kind: "tracker", display_name: "Tracker"});
    expect((await w.post("wiki.list", {project: "tracker"})).status).toBe(400);
    expect((await SELF.fetch("https://blue.pimwell.test/guide/wiki/secret", {headers: cookieHeaders(outsider.token, "blue.pimwell.test")})).status).toBe(404);
    expect((await SELF.fetch("https://" + w.host + "/guide/wiki/secret")).status).toBe(404);
  });
  it("renders safe pages, history and diff and supports form writes/revert with concurrency and CSRF checks", async () => {
    const w = await world();
    const headers = cookieHeaders(w.member.token, w.host);
    const form = (expected: number, body: string) => SELF.fetch("https://" + w.host + "/api/wiki.write", {method: "POST", headers: {...headers, "content-type": "application/x-www-form-urlencoded"}, body: new URLSearchParams({project: "guide", slug: "start", title: "Start", body, note: "Form change", expected_revision: String(expected), _back: "@result"}).toString(), redirect: "manual"});
    expect((await form(0, "**First** [[target]] <script>bad()</script>")).status).toBe(303);
    expect((await form(1, "Second")).status).toBe(303);
    const get = async (path: string, token = w.member.token) => (await SELF.fetch("https://" + w.host + path, {headers: cookieHeaders(token, w.host)})).text();
    const old = await get("/guide/wiki/start?revision=1&diff=1");
    expect(old).toContain("Revert to revision 1");
    expect(old).toContain('name="expected_revision" value="2"');
    expect(old).toContain('<a href="/guide/wiki/target">target</a>');
    expect(old).toContain("&lt;script&gt;");
    expect(old).not.toContain("<script>bad()");
    expect(await get("/guide/wiki/start?revision=2&diff=1")).toContain("Diff from revision 1");
    expect((await form(2, "**First** [[target]] <script>bad()</script>")).status).toBe(303);
    expect((await form(2, "stale form")).status).toBe(409);
    expect(await get("/guide/wiki")).toContain('href="/guide/wiki/start"');
    expect(await get("/guide")).toContain('href="/guide/wiki"');
    expect(await get("/guide/wiki/start", w.reader.token)).not.toContain('action="/api/wiki.write"');
    expect(wikiMarkdown('[[x]] [[x" onclick="bad]] <img src=x onerror=bad>', "guide")).not.toContain("<img");
    expect((await SELF.fetch("https://" + w.host + "/api/wiki.write", {method: "POST", headers: {...headers, origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded"}, body: "project=guide"})).status).toBe(403);
  });
});

describe("project deletion from the web", () => {
  async function world() {
    const tenant = await seedTenant("acme"), blue = await seedTenant("blue");
    const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: tenant.id, role: "admin" }] });
    const member = await seedHuman("member@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
    const bot = await seedAgent(tenant, admin.identity);
    const host = "acme.pimwell.test", headers = cookieHeaders(admin.token, host);
    const post = (verb: string, args: unknown) => apiPost(host, verb, args, headers);
    const form = (verb: string, args: Record<string, string>, h = headers) => SELF.fetch(`https://${host}/api/${verb}`, {
      method: "POST", headers: { ...h, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(args).toString(), redirect: "manual",
    });
    const get = async (path: string, token = admin.token) => (await SELF.fetch(`https://${host}${path}`, { headers: cookieHeaders(token, host) })).text();
    const count = async (table: string, column: string, id: string) => (await env.HUB_DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(id).first<{ n: number }>())!.n;
    expect((await form("project.create", { slug: "gone", kind: "workspace", display_name: "Gone", _back: "@result" })).status).toBe(303);
    const project = await env.HUB_DB.prepare("SELECT * FROM project WHERE tenant_id = ? AND slug = 'gone'").bind(tenant.id).first<any>();
    return { tenant, blue, admin, member, bot, host, headers, post, form, get, count, project };
  }

  it("creates, archives and confirms deletion with web forms; purges content, channels, objects and indexes without touching siblings or other tenants", async () => {
    const w = await world(), db = env.HUB_DB;
    expect(await w.get("/")).toContain('action="/api/project.archive"');
    expect(await w.get("/projects/new")).toContain('action="/api/project.create"');
    expect(await w.get("/", w.member.token)).not.toContain('action="/api/project.archive"');
    const other = await w.post("project.create", { slug: "keep", kind: "workspace", display_name: "Keep" });
    const keep = (await other.json() as any).result.project;
    const foreign = await seedHuman("foreign@example.com", { memberships: [{ tenant_id: w.blue.id, role: "admin" }] });
    const foreignPost = (verb: string, args: unknown) => apiPost("blue.pimwell.test", verb, args, cookieHeaders(foreign.token, "blue.pimwell.test"));
    const foreignProject = (await (await foreignPost("project.create", { slug: "gone", kind: "workspace", display_name: "Foreign" })).json() as any).result.project;
    for (const [post, slug] of [[w.post, "gone"], [w.post, "keep"], [foreignPost, "gone"]] as const) {
      expect((await post("wiki.write", { project: slug, slug: "page", title: "Page", body: "private page", note: "Create", expected_revision: 0 })).status).toBe(200);
      expect((await post("research.save", { project: slug, slug: "research", topic: "Topic", summary: "Findings", status: "final", note: "Create research", sources: [], expected_revision: 0 })).status).toBe(200);
      expect((await post("file.put", { project: slug, path: "a.txt", content_type: "text/plain", base64: btoa("private file"), expected_revision: 0 })).status).toBe(200);
    }
    const item = (await (await w.post("work.create", { project: "gone", kind: "quest", title: "Gone work", body: "private body" })).json() as any).result.item;
    expect((await w.post("work.comment", { id: item.id, body: "@member private comment" })).status).toBe(200);
    expect((await w.post("work.link", { id: item.id, target_kind: "url", target_ref: "https://example.com" })).status).toBe(200);
    expect((await w.post("work.resources", { id: item.id, resources: ["machine"] })).status).toBe(200);
    const keepItem = (await (await w.post("work.create", { project: "keep", kind: "errand", title: "Keep work" })).json() as any).result.item;
    await db.prepare("UPDATE work_item SET parent_id = ? WHERE id = ?").bind(item.id, keepItem.id).run();
    await db.prepare("INSERT INTO work_dep (tenant_id, prereq_id, dependent_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(w.tenant.id, item.id, keepItem.id, w.admin.identity.id, Date.now()).run();
    await db.prepare("INSERT INTO work_proposal (id, tenant_id, item_id, reason, change_json, created_by, created_at) VALUES ('proposal', ?, ?, 'Reason', '{}', ?, ?)").bind(w.tenant.id, item.id, w.admin.identity.id, Date.now()).run();
    await db.prepare("INSERT INTO work_proposal_decision (proposal_id, decision, decided_by, decided_at) VALUES ('proposal', 'rejected', ?, ?)").bind(w.admin.identity.id, Date.now()).run();
    const mailId = "01M4SAWA8WS2CZ9Q39VYMBC5N8";
    await db.prepare(`INSERT INTO inbound_mail (id, tenant_id, project_id, identity_id, from_email, to_address, subject, text, received_at, size, verdict, attachments, forwarded) VALUES (?, ?, ?, ?, 'sender@example.com', 'acme.gone@pimwell.test', 'private mail', 'private body', ?, 10, 'admitted', '[]', 0)`).bind(mailId, w.tenant.id, w.project.id, w.admin.identity.id, Date.now()).run();
    await db.prepare(`INSERT INTO outbound_mail (id, tenant_id, from_address, to_address, subject, text, in_reply_to, sent_by, status, created_at) VALUES ('out', ?, 'acme@pimwell.test', 'sender@example.com', 'Re', 'Reply', ?, ?, 'sent', ?)`).bind(w.tenant.id, mailId, w.admin.identity.id, Date.now()).run();
    for (const [key, value] of [
      [`mail_response_recipients:v1:${w.tenant.id}:${w.project.id}`, "{}"],
      [`mail_response_intent:v1:${w.tenant.id}:${mailId}:${w.admin.identity.id}`, "{}"],
      [`mail_replay:v1:${w.tenant.id}:hash`, JSON.stringify({ mail_id: mailId })],
      [`review_request:v1:${w.tenant.id}:caller:key`, JSON.stringify({ result: { review: { project_id: w.project.id } } })],
    ]) await db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").bind(key, value).run();
    const ch = await db.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = 'gone-team'").bind(w.tenant.id).first<{ id: string }>();
    expect((await w.post("chat.post", { c: "gone-team", body: "private message" })).status).toBe(200);
    expect((await w.post("chat.heartbeat", { c: "gone-team", status: "online" })).status).toBe(200);
    const inbox = inboxStub(env, w.tenant.id, w.admin.identity.id);
    await inbox.deliver(w.tenant.id, w.admin.identity.id, [{ key: `mail:${mailId}`, kind: "mail", conversation_id: "mail", msg_id: mailId, seq: 0, thread_root: null, hop: 0, author_id: w.member.identity.id, wake: false, created_at: Date.now() }]);
    const orphan = `project-files/${w.tenant.id}/${w.project.id}/orphan`;
    await env.GIT_PUSH_STAGING!.put(orphan, "orphan bytes");
    // Seed every project-bearing subsystem, including child tables with no project column.
    const now = Date.now();
    for (const p of [w.project, keep]) {
      await db.prepare("INSERT INTO review (id, tenant_id, project_id, number, branch, base, title, status, author_id, created_at, updated_at) VALUES (?, ?, ?, 1, 'feature', 'main', 'Review', 'open', ?, ?, ?)").bind(`review-${p.id}`, w.tenant.id, p.id, w.admin.identity.id, now, now).run();
      await db.prepare("INSERT INTO review_reviewer (review_id, identity_id) VALUES (?, ?)").bind(`review-${p.id}`, w.member.identity.id).run();
      await db.prepare("INSERT INTO review_comment (id, review_id, tenant_id, author_id, body, created_at) VALUES (?, ?, ?, ?, 'private review comment', ?)").bind(`comment-${p.id}`, `review-${p.id}`, w.tenant.id, w.member.identity.id, now).run();
      await db.prepare("INSERT INTO attention (id, tenant_id, identity_id, reason, actor_id, summary, created_at, href) VALUES (?, ?, ?, 'assigned', ?, 'Review this', ?, ?)").bind(`attention-${p.id}`, w.tenant.id, w.member.identity.id, w.admin.identity.id, now, `/${p.slug}/reviews/1`).run();
      await db.prepare("INSERT INTO code_sync (tenant_id, project_id, cursor) VALUES (?, ?, '5')").bind(w.tenant.id, p.id).run();
      await db.prepare("INSERT INTO code_event (tenant_id, project_id, ardi_id, kind, at) VALUES (?, ?, 1, 'commit', ?)").bind(w.tenant.id, p.id, now).run();
      await db.prepare("INSERT INTO app_source (id, tenant_id, project_id, script_name, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)").bind(`app-${p.id}`, w.tenant.id, p.id, `script-${p.slug}`, now).run();
      await db.prepare("INSERT INTO app_stat (tenant_id, script_name, hour, requests) VALUES (?, ?, ?, 3)").bind(w.tenant.id, `script-${p.slug}`, now).run();
      await db.prepare("INSERT INTO app_deploy (id, tenant_id, project_id, script_name, version_id, seen_at) VALUES (?, ?, ?, ?, 'v1', ?)").bind(`deploy-${p.id}`, w.tenant.id, p.id, `script-${p.slug}`, now).run();
      await db.prepare("INSERT INTO app_error_group (id, tenant_id, project_id, script_name, fingerprint, kind, title, last_message, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, 'error', 'Oops', 'private detail', ?, ?)").bind(`group-${p.id}`, w.tenant.id, p.id, `script-${p.slug}`, p.id, now, now).run();
      await db.prepare("INSERT INTO app_event (id, tenant_id, group_id, at, detail) VALUES (?, ?, ?, ?, 'private occurrence')").bind(`event-${p.id}`, w.tenant.id, `group-${p.id}`, now).run();
      await db.prepare("INSERT INTO model_call (id, purpose, provider, model, tenant_id, project_id, ok, ms, created_at) VALUES (?, 'test', 'test', 'test', ?, ?, 1, 1, ?)").bind(`usage-${p.id}`, w.tenant.id, p.id, now).run();
      expect((await w.post("file.upload_url", { project: p.slug, path: "pending.txt", content_type: "text/plain", expected_revision: 0 })).status).toBe(200);
    }
    expect((await w.post("channel.add_agent", { c: "gone-team", agent: "bot" })).status).toBe(200);
    const snapshot = await db.prepare("SELECT * FROM wiki_revision WHERE project_id IN (?, ?)").bind(keep.id, foreignProject.id).all();
    expect((await w.form("project.archive", { slug: "gone", _back: "/archive" })).status).toBe(303);
    const archive = await w.get("/archive");
    expect(archive).toContain('action="/api/project.delete"');
    expect(archive).toContain('name="confirm"');
    expect(archive).toContain('pattern="gone"');
    expect(await w.get("/archive", w.member.token)).not.toContain('action="/api/project.delete"');
    const res = await w.form("project.delete", { slug: "gone", confirm: "gone", _back: "@result" });
    expect(res.status, await res.clone().text()).toBe(303);
    expect(res.headers.get("location")).toBe("/archive");
    for (const table of ["project", "work_item", "wiki_revision", "file_revision", "file_upload", "inbound_mail", "channel", "review", "app_source", "app_deploy", "app_error_group", "code_sync", "code_event", "model_call"]) {
      expect(await w.count(table, table === "project" ? "id" : "project_id", w.project.id), table).toBe(0);
    }
    for (const table of ["work_comment", "work_link", "work_resource", "attention", "work_proposal"]) expect(await w.count(table, "item_id", item.id), table).toBe(0);
    for (const [table, column, id] of [["review_comment", "review_id", `review-${w.project.id}`], ["review_reviewer", "review_id", `review-${w.project.id}`], ["attention", "id", `attention-${w.project.id}`], ["app_event", "group_id", `group-${w.project.id}`], ["app_stat", "script_name", "script-gone"]]) expect(await w.count(table!, column!, id!), table).toBe(0);
    for (const table of ["review", "app_source", "app_deploy", "app_error_group", "code_sync", "code_event", "model_call", "file_upload"]) expect(await w.count(table, "project_id", keep.id), table).toBe(1);
    expect(await w.count("attention", "id", `attention-${keep.id}`)).toBe(1);
    expect(await w.count("work_dep", "prereq_id", item.id)).toBe(0);
    expect(await w.count("work_proposal_decision", "proposal_id", "proposal")).toBe(0);
    expect(await w.count("outbound_mail", "id", "out")).toBe(0);
    expect(await w.count("project", "id", ch!.id)).toBe(0);
    expect(await w.count("msg_index", "conversation_id", ch!.id)).toBe(0);
    expect(await w.count("msg_ref", "conversation_id", ch!.id)).toBe(0);
    expect(await w.count("conversation_member", "conversation_id", ch!.id)).toBe(0);
    const storage = await runInDurableObject(conversationStub(env, w.tenant.id, ch!.id), async (_instance, state) => ({
      messages: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM artifact").one().n,
      meta: state.storage.sql.exec<{ key: string }>("SELECT key FROM meta ORDER BY key").toArray().map(r => r.key),
      presence: await state.storage.get("presence:v1"), alarm: await state.storage.getAlarm(),
    }));
    expect(storage).toEqual({ messages: 0, meta: ["deleted", "owner_id", "tenant_id"], presence: undefined, alarm: null });
    expect(await runInDurableObject(conversationStub(env, w.tenant.id, ch!.id), async instance => {
      try { await (instance as Conversation).notice(w.tenant.id, ch!.id, "late post", Date.now()); return "posted"; }
      catch (e) { return (e as Error).message; }
    })).toBe("conversation deleted");
    expect((await inbox.list(w.tenant.id, w.admin.identity.id, { after: 0, limit: 100, include_acked: true })).items.some(i => i.msg_id === mailId || i.conversation_id === ch!.id)).toBe(false);
    expect((await env.GIT_PUSH_STAGING!.list({ prefix: `project-files/${w.tenant.id}/${w.project.id}/` })).objects).toEqual([]);
    expect((await db.prepare("SELECT * FROM wiki_revision WHERE project_id IN (?, ?)").bind(keep.id, foreignProject.id).all()).results).toEqual(snapshot.results);
    expect((await db.prepare("SELECT parent_id FROM work_item WHERE id = ?").bind(keepItem.id).first())).toEqual({ parent_id: null });
    expect((await db.prepare("SELECT key FROM meta WHERE key IN (?, ?, ?, ?)").bind(
      `mail_response_recipients:v1:${w.tenant.id}:${w.project.id}`, `mail_response_intent:v1:${w.tenant.id}:${mailId}:${w.admin.identity.id}`,
      `mail_replay:v1:${w.tenant.id}:hash`, `review_request:v1:${w.tenant.id}:caller:key`).all()).results).toEqual([]);
    expect(await w.count("file_revision", "project_id", keep.id)).toBe(1);
    expect(await w.count("file_revision", "project_id", foreignProject.id)).toBe(1);
    expect(await w.count("identity", "id", w.bot.agent.identity.id)).toBe(1);
    expect(await w.count("membership", "tenant_id", w.blue.id)).toBe(1);
    const events = (await db.prepare("SELECT summary FROM event WHERE tenant_id = ? AND target_id = ?").bind(w.tenant.id, w.project.id).all<{ summary: string }>()).results;
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toContain('"work_item":1');
    expect(events[0]!.summary).not.toContain('"repositories"');
    expect(events[0]!.summary).toContain('"message_versions":1');
    expect((await w.post("project.delete", { slug: "gone", confirm: "gone" })).status).toBe(404);
  });

  it("refuses active projects, wrong slug, non-admins, agents, assistant calls, bearer sessions, stale proofs and cross-origin forms before changing data", async () => {
    const w = await world(), args = { slug: "gone", confirm: "gone" };
    expect((await w.post("project.delete", args)).status).toBe(409);
    expect((await w.post("project.archive", { slug: "gone" })).status).toBe(200);
    expect((await w.post("project.delete", { ...args, confirm: "Gone" })).status).toBe(400);
    expect((await w.post("project.delete", { ...args, confirm: "" })).status).toBe(400);
    for (const token of [w.member.token, w.bot.token, w.admin.token]) expect((await apiPost(w.host, "project.delete", args, bearer(token))).status).toBe(403);
    expect(await (await apiPost(w.host, "project.delete", args, bearer(w.bot.token))).text()).toContain("sign in on the web");
    const ctx = await buildContext(new Request(`https://${w.host}/`, { headers: bearer(w.bot.token) }), env);
    const result = await callTool(ctx, "project_delete", args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("sign in on the web");
    expect((await w.form("project.delete", args, { ...w.headers, origin: "https://evil.test" })).status).toBe(403);
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 600_001, w.admin.session.id).run();
    const stale = await w.post("project.delete", args);
    expect(stale.status).toBe(403); expect(await stale.text()).toContain("reproof_required");
    expect(await w.count("project", "id", w.project.id)).toBe(1);
    expect((await apiPost("blue.pimwell.test", "project.delete", args, cookieHeaders(w.admin.token, "blue.pimwell.test"))).status).toBe(404);
  });

  it("does not adopt an existing similarly-named channel, and resolves namespaced deletion without touching a top-level project", async () => {
    const w = await world();
    await w.post("channel.create", { slug: "collision-team", topic: "Unrelated" });
    await w.post("project.create", { slug: "collision", kind: "tracker", display_name: "Collision" });
    await w.post("project.archive", { slug: "collision" });
    expect((await w.post("project.delete", { slug: "collision", confirm: "collision" })).status).toBe(200);
    expect((await w.post("chat.post", { c: "collision-team", body: "Still here" })).status).toBe(200);
    await w.post("namespace.create", { slug: "research", display_name: "Research" });
    const made = await w.post("project.create", { slug: "gone", namespace: "research", kind: "tracker", display_name: "Namespaced" });
    const ns = (await made.json() as any).result.project;
    await w.post("project.archive", { slug: "gone", namespace: "research" });
    const html = await w.get("/archive"); expect(html).toContain('name="namespace" value="research"');
    expect((await w.post("project.delete", { slug: "gone", namespace: "research", confirm: "gone" })).status).toBe(200);
    expect(await w.count("project", "id", ns.id)).toBe(0);
    expect(await w.count("project", "id", w.project.id)).toBe(1);
    expect((await w.post("chat.post", { c: "gone-team", body: "Top-level still here" })).status).toBe(200);
    // Older defaults have no ownership meta, and their editable topics may have changed.
    await env.HUB_DB.prepare("DELETE FROM meta WHERE value = ?").bind(w.project.id).run();
    await w.post("channel.set_topic", { c: "gone-team", topic: "Changed topic" });
    await w.post("project.archive", { slug: "gone" });
    expect((await w.post("project.delete", { slug: "gone", confirm: "gone" })).status).toBe(200);
    expect((await env.HUB_DB.prepare("SELECT slug FROM project WHERE tenant_id = ? AND slug IN ('gone-team', 'gone-ops')").bind(w.tenant.id).all()).results).toEqual([]);
  });

  it("keeps a failed external deletion archived and retryable, then deletes the owned Artifacts repo and records one event", async () => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${w.host}/`, { headers: w.headers }), env);
    const made = await projectCreate.run(ctx, projectCreate.parse({ slug: "repo", kind: "repo", display_name: "Repo" })) as { project: { id: string } };
    await w.post("project.archive", { slug: "repo" });
    await env.HUB_DB.prepare("INSERT INTO git_repository (tenant_id, project_id, imported_at) VALUES (?, ?, ?)").bind(w.tenant.id, made.project.id, Date.now()).run();
    ctx.env = { ...env, ARTIFACTS_ACCOUNT_ID: "0".repeat(32), ARTIFACTS_API_TOKEN: "synthetic-test-token" };
    const deletion = vi.spyOn(ArtifactsRest.prototype, "deleteProject").mockRejectedValueOnce(new Error("storage outage")).mockResolvedValue(undefined);
    try {
      await expect(projectDelete.run(ctx, projectDelete.parse({ slug: "repo", confirm: "repo" }))).rejects.toThrow("storage outage");
      expect(await w.count("project", "id", made.project.id)).toBe(1);
      expect((await w.post("project.unarchive", { slug: "repo" })).status).toBe(409);
      const result = await projectDelete.run(ctx, projectDelete.parse({ slug: "repo", confirm: "repo" }));
      expect(result.counts.repositories).toBe(1);
      expect(deletion).toHaveBeenLastCalledWith("acme", "repo", `Pimwell tenant ${w.tenant.id} project ${made.project.id}`);
      expect(await w.count("project", "id", made.project.id)).toBe(0);
      expect((await env.HUB_DB.prepare("SELECT kind FROM event WHERE target_id = ?").bind(made.project.id).all()).results).toEqual([{ kind: "project.delete" }]);
    } finally { deletion.mockRestore(); }
  });
});
