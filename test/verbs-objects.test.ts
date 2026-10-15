import { env, SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";
import { listEvents } from "../src/db/events";
import { getTenantBySlug } from "../src/db/tenants";
import { buildContext } from "../src/auth/context";
import { callTool } from "../src/mcp/tools";
import { wikiMarkdown } from "../src/http/wikiPages";
import type { Conversation } from "../src/chat/conversationDO";
import type { ChatUpdate } from "../src/chat/updates";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { projectDelete, projectCreate } from "../src/verbs/project";
import { ArtifactsRest, validationRepository } from "../src/code/artifactsRest";
import { vi } from "vitest";
import { deleteProject, PROJECT_DELETE_SCOPED_TABLES, PROJECT_DELETE_OTHER_TABLES } from "../src/db/projectDelete";
import { cleanupFileObjects, FILE_ORPHAN_GRACE_MS, FILE_CLEANUP_CURSOR, FILE_CLEANUP_LIMIT } from "../src/db/fileCleanup";
import { ulid } from "../src/ids";

describe("orphan file cleanup", () => {
  it("keeps all versions and hidden evidence; dry runs preserve storage and cursor", async () => {
    const tenant = await seedTenant("cleanup");
    const admin = await seedHuman("cleanup@example.com", {memberships: [{tenant_id: tenant.id, role: "admin"}]});
    const post = (verb: string, args: object) => apiPost("cleanup.pimwell.test", verb, args, bearer(admin.token));
    expect((await post("project.create", {slug: "files", kind: "workspace", display_name: "Files"})).status).toBe(200);
    for (const expected_revision of [0, 1]) expect((await post("file.put", {project: "files", path: "a.txt", content_type: "text/plain", base64: btoa("evidence"), expected_revision})).status).toBe(200);
    await env.HUB_DB.prepare("UPDATE file_revision SET deleted = 1 WHERE tenant_id = ?").bind(tenant.id).run();
    const refs = (await env.HUB_DB.prepare("SELECT object_key FROM file_revision WHERE tenant_id = ?").bind(tenant.id).all<{object_key: string}>()).results.map(r => r.object_key);
    const project = refs[0]!.split("/")[2]!;
    const orphan = `project-files/${tenant.id}/${project}/${ulid()}`;
    const deletedProject = `project-files/${tenant.id}/${ulid()}/${ulid()}`;
    const deletedTenant = `project-files/${ulid()}/${ulid()}/${ulid()}`;
    const young = `project-files/${tenant.id}/${project}/${ulid()}`;
    const malformed = `project-files/${tenant.id}/${project}-sibling/${ulid()}`;
    const git = `git-push/${tenant.id}/${project}/${ulid()}`;
    const bucket = env.GIT_PUSH_STAGING!;
    for (const key of [orphan, deletedProject, deletedTenant, young, malformed, git]) await bucket.put(key, "data");
    const now = Date.now();
    const wrapped = {...env, GIT_PUSH_STAGING: {
      list: async (options: R2ListOptions) => {
        expect(options.prefix).toBe("project-files/");
        expect(options.limit).toBe(FILE_CLEANUP_LIMIT);
        const page = await bucket.list(options);
        return {...page, objects: page.objects.map(o => ({...o, uploaded: new Date(now - FILE_ORPHAN_GRACE_MS + (o.key === young ? 1 : -1))}))};
      }, delete: (key: string) => bucket.delete(key),
    } as R2Bucket};
    expect(await cleanupFileObjects(wrapped, now)).toMatchObject({eligible: 3, deleted: 0, dry_run: true});
    expect(await env.HUB_DB.prepare("SELECT 1 FROM meta WHERE key = ?").bind(FILE_CLEANUP_CURSOR).first()).toBeNull();
    expect(await bucket.head(orphan)).not.toBeNull();
    expect(await cleanupFileObjects(wrapped, now, false)).toMatchObject({eligible: 3, deleted: 3});
    for (const key of [orphan, deletedProject, deletedTenant]) expect(await bucket.head(key)).toBeNull();
    for (const key of [...refs, young, malformed, git]) expect(await bucket.head(key)).not.toBeNull();
  });

  it("advances bounded pages only after success, wraps, and fails closed on D1 errors", async () => {
    const key = `project-files/${ulid()}/${ulid()}/${ulid()}`;
    const del = vi.fn();
    const list = vi.fn().mockResolvedValue({objects: [{key, uploaded: new Date(0)}], truncated: true, cursor: "page2"});
    const wrapped = {...env, GIT_PUSH_STAGING: {list, delete: del} as unknown as R2Bucket};
    await cleanupFileObjects(wrapped, Date.now(), false);
    expect(del).toHaveBeenCalledWith(key);
    expect((await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(FILE_CLEANUP_CURSOR).first())).toEqual({value: "page2"});
    list.mockResolvedValue({objects: [], truncated: false});
    await cleanupFileObjects(wrapped, Date.now());
    expect(list).toHaveBeenLastCalledWith({prefix: "project-files/", limit: FILE_CLEANUP_LIMIT, cursor: "page2"});
    expect((await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(FILE_CLEANUP_CURSOR).first())).toEqual({value: "page2"});
    await cleanupFileObjects(wrapped, Date.now(), false);
    expect((await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(FILE_CLEANUP_CURSOR).first())).toEqual({value: ""});
    list.mockResolvedValue({objects: [{key, uploaded: new Date(0)}], truncated: false});
    del.mockClear();
    const prepare = vi.fn((sql: string) => ({bind: () => ({first: async () => {
      if (sql.includes("file_revision")) throw new Error("D1 unavailable");
      return null;
    }})}));
    await expect(cleanupFileObjects({...wrapped, HUB_DB: {prepare} as unknown as D1Database}, Date.now(), false)).rejects.toThrow("D1 unavailable");
    expect(del).not.toHaveBeenCalled();
  });
});

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
  it("keeps duplicate namespaced project pages, MCP references and search links isolated", async () => {
    const tenant = await seedTenant("acme");
    const other = await seedTenant("other");
    const admin = await seedHuman("admin@example.com", {memberships: [{tenant_id: tenant.id, role: "admin"}, {tenant_id: other.id, role: "admin"}]});
    const host = "acme.pimwell.test";
    const post = (verb: string, args: unknown, h = host) => apiPost(h, verb, args, bearer(admin.token));
    for (const h of [host, "other.pimwell.test"]) {
      for (const namespace of ["east", "west"]) {
        expect((await post("namespace.create", {slug: namespace, display_name: namespace}, h)).status).toBe(200);
        expect((await post("project.create", {namespace, slug: "guide", kind: "workspace", display_name: namespace + " guide"}, h)).status).toBe(200);
        expect((await post("wiki.write", {project: namespace + "/guide", slug: "start", title: namespace + " unique", body: h + " [[target]]", expected_revision: 0, note: "new"}, h)).status).toBe(200);
      }
    }
    const ctx = await buildContext(new Request("https://" + host + "/agent/mcp", {headers: bearer(admin.token)}), env);
    ctx.playground = {scopes: ["read", "write"]};
    for (const namespace of ["east", "west"]) {
      const project = namespace + "/guide";
      expect((await post("work.create", {project, kind: "snag", title: namespace + " work", body: "scoped"})).status).toBe(200);
      const read = await callTool(ctx, "wiki_read", {project, slug: "start"});
      expect(read.isError, JSON.stringify(read)).toBeUndefined();
      expect(JSON.stringify(read)).toContain(namespace + " unique");
      expect(JSON.stringify(read)).not.toContain("other.pimwell.test");
      for (const suffix of ["", "?resource=wiki", "/wiki", "/wiki/start", "/documents", "/contacts", "/docket", "/board", "/status"]) {
        const res = await SELF.fetch("https://" + host + "/" + project + suffix, {headers: cookieHeaders(admin.token, host)});
        expect(res.status, project + suffix).toBe(200);
        const html = await res.text();
        if (suffix === "" || suffix === "?resource=wiki" || suffix === "/wiki") {
          expect(html).toContain("/" + project + (suffix === "" ? "?resource=wiki" : "/wiki"));
          expect(html).not.toContain((namespace === "east" ? "west" : "east") + " unique");
        }
        if (suffix === "/wiki/start") {
          expect(html).toContain("/" + project + "/wiki/target");
          expect(html).toContain('name="project" value="' + project + '"');
        }
      }
      const p = await env.HUB_DB.prepare("SELECT p.id FROM project p JOIN namespace n ON n.id = p.namespace_id WHERE p.tenant_id = ? AND n.slug = ?").bind(tenant.id, namespace).first<{id: string}>();
      ctx.mcpProject = {id: p!.id, slug: "guide", path: project, kind: "workspace", parts: JSON.stringify(["docket","wiki","knowledge","files","people"]), display_name: project};
      expect((await callTool(ctx, "wiki_read", {project, slug: "start"})).isError).toBeUndefined();
      expect((await callTool(ctx, "wiki_read", {project: (namespace === "east" ? "west" : "east") + "/guide", slug: "start"})).isError).toBe(true);
      const board = await callTool(ctx, "work_board", {});
      expect(board.isError, JSON.stringify(board)).toBeUndefined();
      expect(JSON.stringify(board)).toContain(project + "#1");
      ctx.mcpProject = undefined;
    }
    expect((await post("wiki.read", {project: "guide", slug: "start"})).status).toBe(404);
    expect((await post("wiki.read", {project: "missing/guide", slug: "start"})).status).toBe(404);
    expect((await post("wiki.write", {project: "east/guide", slug: "start", title: "east revised", body: "changed", expected_revision: 1, note: "edit"})).status).toBe(200);
    const west = (await (await post("wiki.history", {project: "west/guide", slug: "start"})).json()) as any;
    expect(west.result.history).toHaveLength(1);
    const east = (await (await post("wiki.history", {project: "east/guide", slug: "start"})).json()) as any;
    expect(east.result.history).toHaveLength(2);
    expect((await SELF.fetch("https://" + host + "/guide", {headers: cookieHeaders(admin.token, host)})).status).toBe(404);
    const search = (await (await post("search.query", {q: "unique"})).json()) as any;
    expect(search.result.wiki.map((r: any) => r.href)).toEqual(["/west/guide/wiki/start"]);
    const projects = (await (await post("search.query", {q: "guide"})).json()) as any;
    expect(projects.result.projects.map((r: any) => r.ref).sort()).toEqual(["east/guide", "west/guide"]);
  });

  async function world(kind = "wiki") {
    const tenant = await seedTenant("acme");
    const member = await seedHuman("writer@example.com", {memberships: [{tenant_id: tenant.id, role: "member"}]});
    const admin = await seedHuman("admin@example.com", {memberships: [{tenant_id: tenant.id, role: "admin"}]});
    const reader = await seedHuman("reader@example.com", {memberships: [{tenant_id: tenant.id, role: "reader"}]});
    const host = "acme.pimwell.test";
    const post = (verb: string, args: unknown, token = member.token) => apiPost(host, verb, args, bearer(token));
    expect((await post("project.create", {slug: "guide", kind, display_name: "Guide"})).status).toBe(200);
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
  it("attaches repo screenshots separately from code and denies outsiders", async () => {
    const w = await world("repo");
    const created = await (await w.post("work.create", {project: "guide", kind: "snag", title: "Acceptance"})).json() as any;
    const item = created.result.item;
    const ctx = await buildContext(new Request(`https://${w.host}/mcp`, {headers: bearer(w.member.token)}), env);
    ctx.playground = {scopes: ["read", "write"]};
    const params = {project: "guide", path: "evidence/screenshot.png", content_type: "image/png", expected_revision: 0, item_id: item.id, base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII="};
    expect((await callTool(ctx, "file_put", params)).isError).toBeUndefined();
    const file = await callTool(ctx, "file_get", {project: "guide", path: params.path});
    expect(file.structuredContent).toMatchObject({file: {item_id: item.id}});
    const url = "/guide/documents/download?path=evidence%2Fscreenshot.png&revision=1";
    expect((await w.post("work.comment", {id: item.id, body: `![Acceptance](${url})`})).status).toBe(200);
    const get = (path: string, token = w.reader.token) => SELF.fetch(`https://${w.host}${path}`, {headers: cookieHeaders(token, w.host)});
    expect(await (await get(`/guide/w/${item.number}`)).text()).toContain(`<img src="${url.replace("&", "&amp;")}"`);
    expect((await get("/guide/documents")).status).toBe(200);
    const image = await get(url);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toBe("private, no-store");
    expect((await w.post("file.put", {...params, path: "reader.png"}, w.reader.token)).status).toBe(403);
    expect((await w.post("file.put", {...params, path: "missing.png", item_id: "00000000000000000000000000"})).status).toBe(404);
    const outsider = await seedHuman("repo-outsider@example.com");
    for (const path of [url, `/guide/w/${item.number}`, "/guide/documents"]) {
      expect((await get(path, outsider.token)).status).not.toBe(200);
      expect((await SELF.fetch(`https://${w.host}${path}`)).status).not.toBe(200);
    }
    expect((await w.post("file.get", {project: "guide", path: params.path}, outsider.token)).status).not.toBe(200);
  });
  it("renders revision-pinned authenticated raster evidence authored over MCP and browser forms", async () => {
    const w = await world("workspace");
    const headers = cookieHeaders(w.member.token, w.host);
    const ctx = await buildContext(new Request(`https://${w.host}/mcp`, {headers: bearer(w.member.token)}), env);
    ctx.playground = {scopes: ["read", "write"]};
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
    for (const expected_revision of [0, 1]) expect((await callTool(ctx, "file_put", {project: "guide", path: "debug/plan.png", content_type: "image/png", base64: png, expected_revision})).isError).toBeUndefined();
    const url = "/guide/documents/download?path=debug%2Fplan.png&revision=1";
    const body = `![Plan <script>bad()</script>](${url})`;
    expect((await callTool(ctx, "wiki_write", {project: "guide", slug: "visuals", title: "Visuals", body, expected_revision: 0, note: "Evidence"})).isError).toBeUndefined();
    const get = (path: string, token = w.reader.token) => SELF.fetch(`https://${w.host}${path}`, {headers: cookieHeaders(token, w.host)});
    const html = await (await get("/guide/wiki/visuals")).text();
    expect(html).toContain(`<img src="${url.replace("&", "&amp;")}"`);
    expect(html).toContain("max-height:480px");
    expect(html).toContain("Open original · revision 1");
    expect(html).toContain("Plan &lt;script&gt;");
    expect(html).not.toContain("<script>bad()");
    const image = await get(url);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toBe("private, no-store");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    const outsider = await seedHuman("outsider-image@example.com");
    expect((await get(url, outsider.token)).status).not.toBe(200);
    expect((await SELF.fetch(`https://${w.host}${url}`)).status).not.toBe(200);
    const invalid = ["https://tracker.test/p.png", "https://blue.pimwell.test" + url, url.replace("/guide/", "/other/"), url.replace("revision=1", "revision=0"), url.replace("&revision=1", ""), "javascript:bad", "/guide/documents/download?path=missing.png&revision=1"];
    const badBody = invalid.map(u => `![bad](${u})`).join("\n");
    const form = await SELF.fetch(`https://${w.host}/api/wiki.write`, {method: "POST", headers: {...headers, "content-type": "application/x-www-form-urlencoded"}, body: new URLSearchParams({project: "guide", slug: "invalid", title: "Invalid", body: badBody, expected_revision: "0", note: "Browser", _back: "@result"}).toString(), redirect: "manual"});
    expect(form.status).toBe(303);
    expect(await (await get("/guide/wiki/invalid")).text()).not.toContain("<img");
    expect((await w.post("file.put", {project: "guide", path: "bad.svg", content_type: "image/svg+xml", base64: btoa("<svg onload=bad()/>"), expected_revision: 0})).status).toBe(400);
    const created = await (await w.post("work.create", {project: "guide", kind: "snag", title: "Visual evidence", body})).json() as any;
    const id = created.result.item.id;
    expect((await w.post("work.comment", {id, body})).status).toBe(200);
    const item = await env.HUB_DB.prepare("SELECT number FROM work_item WHERE id = ?").bind(id).first<{number: number}>();
    expect((await (await get(`/guide/w/${item!.number}`)).text()).match(/<img /g)).toHaveLength(2);
    expect((await w.post("file.delete", {project: "guide", path: "debug/plan.png"}, w.admin.token)).status).toBe(200);
    expect(await (await get("/guide/wiki/visuals")).text()).not.toContain("<img");
    expect((await get(url)).status).toBe(404);
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

  it("batches counts and bounds inbox purges, draining failures before a retry", async () => {
    const w = await world();
    for (let i = 0; i < 18; i++) await seedAgent(w.tenant, w.admin.identity, `purge-${i}`);
    await w.post("project.archive", {slug: "gone"});
    w.project.state = "archived";
    const ctx = await buildContext(new Request(`https://${w.host}/`, {headers: w.headers}), env);
    const countBatches: number[] = [];
    let countQueries = 0, active = 0, peak = 0, completed = 0, fail = true;
    let conversationActive = 0, conversationCompleted = 0, conversationFail = true;
    let objectActive = 0, objectPeak = 0, objectFail = false;
    const db = {
      prepare(sql: string) {
        if (sql.includes("SELECT COUNT(*)")) countQueries++;
        return env.HUB_DB.prepare(sql);
      },
      batch(statements: D1PreparedStatement[]) {
        countBatches.push(countQueries);
        countQueries = 0;
        return env.HUB_DB.batch(statements);
      },
    } as D1Database;
    const purgeProject = async (tenant: string, identity: string, channels: string[], mail: string[]) => {
      expect(tenant).toBe(w.tenant.id);
      expect(conversationActive).toBe(0);
      expect(identity).toBeTruthy();
      expect(channels).toHaveLength(2);
      expect(mail).toEqual([]);
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      completed++;
      if (fail) { fail = false; throw new Error("inbox outage"); }
      return 1;
    };
    const wrapped = {...ctx, db, env: {...env,
      CONVERSATION: {
        idFromName: (name: string) => name,
        get: () => ({purge: async () => {
          conversationActive++;
          await new Promise(resolve => setTimeout(resolve, 5));
          conversationActive--;
          conversationCompleted++;
          if (conversationFail) { conversationFail = false; throw new Error("conversation outage"); }
          return 0;
        }}),
      } as unknown as typeof env.CONVERSATION,
      INBOX: {
        idFromName: (name: string) => name,
        get: () => ({purgeProject}),
      } as unknown as typeof env.INBOX,
      GIT_PUSH_STAGING: {list: async ({prefix}: {prefix: string}) => {
        expect(prefix).toMatch(new RegExp(`^project-files/${w.tenant.id}/[^/]+/$`));
        objectActive++;
        objectPeak = Math.max(objectPeak, objectActive);
        await new Promise(resolve => setTimeout(resolve, 5));
        objectActive--;
        if (objectFail) { objectFail = false; throw new Error("object outage"); }
        return {objects: [], truncated: false};
      }} as unknown as R2Bucket,
    }};
    await expect(deleteProject(wrapped, w.project)).rejects.toThrow("conversation outage");
    expect(conversationActive).toBe(0);
    expect(conversationCompleted).toBe(2);
    expect(completed).toBe(0);
    await expect(deleteProject(wrapped, w.project)).rejects.toThrow("inbox outage");
    expect(active).toBe(0);
    expect(peak).toBe(10);
    expect(completed).toBe(21);
    expect(await w.count("project", "id", w.project.id)).toBe(1);
    expect(await env.HUB_DB.prepare("SELECT 1 FROM event WHERE kind = 'project.delete'").first()).toBeNull();
    expect(objectActive).toBe(0);
    objectFail = true;
    await expect(deleteProject(wrapped, w.project)).rejects.toThrow("object outage");
    expect(active).toBe(0);
    expect(objectActive).toBe(0);
    expect(await w.count("project", "id", w.project.id)).toBe(1);
    expect(await env.HUB_DB.prepare("SELECT 1 FROM event WHERE kind = 'project.delete'").first()).toBeNull();
    expect(await deleteProject(wrapped, w.project)).toMatchObject({ok: true, counts: {inbox_items: 21, project: 3}});
    expect(countBatches.filter(n => n > 0)).toEqual([44, 44, 44, 44]);
    expect(objectPeak).toBe(3);
    expect(objectActive).toBe(0);
    expect(active).toBe(0);
    expect(await w.count("project", "id", w.project.id)).toBe(0);
  });

  it("lets member agents delete their own active or archived tmp- projects over MCP and API, cascading channels and files", async () => {
    const w = await world(), headers = bearer(w.bot.token);
    const base = await buildContext(new Request(`https://${w.host}/`, { headers }), env);
    const ctx = { ...base, agentMcp: { token_id: "test", scopes: ["read", "write"], sealed: { ciphertext: "", iv: "" } } };
    for (const archived of [false, true]) {
      const slug = archived ? "tmp-archived" : "tmp-active";
      const made = (await (await apiPost(w.host, "project.create", { slug, kind: "workspace", display_name: slug }, headers)).json() as any).result;
      expect((await apiPost(w.host, "file.put", { project: slug, path: "safe.txt", content_type: "text/plain", base64: btoa("safe"), expected_revision: 0 }, headers)).status).toBe(200);
      expect((await apiPost(w.host, "chat.post", { c: `${slug}-team`, body: "Throwaway", after: 0 }, headers)).status).toBe(200);
      const channel = await env.HUB_DB.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = ?").bind(w.tenant.id, `${slug}-team`).first<{id: string}>();
      // Another agent member is permitted.
      const other = await seedAgent(w.tenant, w.admin.identity, `other-${slug}`);
      await env.HUB_DB.prepare("INSERT INTO conversation_member (conversation_id, tenant_id, identity_id, role, added_by, added_at) VALUES (?, ?, ?, 'member', ?, ?)").bind(channel!.id, w.tenant.id, other.agent.identity.id, w.admin.identity.id, Date.now()).run();
      if (archived) await w.post("project.archive", { slug });
      if (archived) expect((await apiPost(w.host, "project.delete", { project: slug }, headers)).status).toBe(200);
      else expect((await callTool(ctx, "project_delete", { project: slug })).structuredContent).toMatchObject({ok: true, counts: {file_objects: 1, message_versions: 1}});
      expect(await w.count("project", "id", made.project.id)).toBe(0);
      expect(await w.count("project", "id", channel!.id)).toBe(0);
      expect(await w.count("conversation_member", "conversation_id", channel!.id)).toBe(0);
      expect((await env.GIT_PUSH_STAGING!.list({prefix: `project-files/${w.tenant.id}/${made.project.id}/`})).objects).toHaveLength(0);
      expect((await env.HUB_DB.prepare("SELECT kind, identity_id FROM event WHERE target_id = ?").bind(made.project.id).all()).results).toEqual([{kind: "project.deleted", identity_id: w.bot.agent.identity.id}]);
    }
    expect(await w.count("project", "id", w.project.id)).toBe(1);
  });

  it("refuses foreign creators, non-tmp slugs, unknown creators and other human members without changing data", async () => {
    const w = await world(), headers = bearer(w.bot.token);
    const base = await buildContext(new Request(`https://${w.host}/`, { headers }), env);
    const ctx = { ...base, agentMcp: { token_id: "test", scopes: ["read", "write"], sealed: { ciphertext: "", iv: "" } } };
    for (const slug of ["tmp-foreign", "not-tmp", "tmp-human", "tmp-unknown"]) {
      const made = (await (await apiPost(w.host, "project.create", {slug, kind: "workspace", display_name: slug}, slug === "tmp-foreign" ? w.headers : headers)).json() as any).result;
      if (slug === "tmp-human") {
        const ch = await env.HUB_DB.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = ?").bind(w.tenant.id, `${slug}-ops`).first<{id: string}>();
        await env.HUB_DB.prepare("INSERT INTO conversation_member (conversation_id, tenant_id, identity_id, role, added_by, added_at) VALUES (?, ?, ?, 'member', ?, ?)").bind(ch!.id, w.tenant.id, w.member.identity.id, w.admin.identity.id, Date.now()).run();
      }
      if (slug === "tmp-unknown") await env.HUB_DB.prepare("DELETE FROM event WHERE target_id = ? AND kind = 'project.create'").bind(made.project.id).run();
      // A later creation/provisioning retry must not confer ownership.
      if (slug === "tmp-foreign") await env.HUB_DB.prepare("INSERT INTO event (id, tenant_id, identity_id, session_id, kind, target_kind, target_id, summary, created_at) VALUES (?, ?, ?, ?, 'project.create', 'project', ?, 'Retry', ?)").bind(ulid(), w.tenant.id, w.bot.agent.identity.id, w.bot.session.id, made.project.id, Date.now() + 1).run();
      expect((await apiPost(w.host, "project.delete", {project: slug}, headers)).status).toBe(403);
      expect((await callTool(ctx, "project_delete", {project: slug})).isError).toBe(true);
      expect(await w.count("project", "id", made.project.id)).toBe(1);
      expect((await env.HUB_DB.prepare("SELECT state FROM project WHERE id = ?").bind(made.project.id).first<any>())!.state).toBe("active");
      expect(await env.HUB_DB.prepare("SELECT 1 FROM meta WHERE key = ?").bind(`project_delete:v1:${w.tenant.id}:${made.project.id}`).first()).toBeNull();
    }
    const reader = await seedAgent(w.tenant, w.admin.identity, "reader", "reader");
    expect((await apiPost(w.host, "project.delete", {project: "tmp-human"}, bearer(reader.token))).status).toBe(403);
    expect((await apiPost("blue.pimwell.test", "project.delete", {project: "tmp-human"}, headers)).status).toBe(404);
  });

  it("deletes an empty namespaced throwaway and retries agent repository purges with original authorization", async () => {
    const w = await world(), headers = bearer(w.bot.token);
    await w.post("namespace.create", {slug: "checks", display_name: "Checks"});
    const ns = (await (await apiPost(w.host, "project.create", {slug: "tmp-empty", namespace: "checks", kind: "wiki", display_name: "Empty"}, headers)).json() as any).result.project;
    expect((await apiPost(w.host, "project.delete", {project: "checks/tmp-empty"}, headers)).status).toBe(200);
    expect(await w.count("project", "id", ns.id)).toBe(0);
    const ctx = await buildContext(new Request(`https://${w.host}/`, {headers}), env);
    const made = await projectCreate.run(ctx, projectCreate.parse({slug: "tmp-repo", kind: "repo", display_name: "Repo"})) as {project: {id: string}};
    await env.HUB_DB.prepare("INSERT INTO git_repository (tenant_id, project_id, imported_at) VALUES (?, ?, ?)").bind(w.tenant.id, made.project.id, Date.now()).run();
    for (const name of ["api", "web"]) await env.HUB_DB.prepare("INSERT INTO repository (tenant_id, project_id, name, storage_name, is_default, created_at) VALUES (?, ?, ?, ?, 0, ?)").bind(w.tenant.id, made.project.id, name, `storage-${name}`, Date.now()).run();
    await env.HUB_DB.prepare("INSERT INTO repository_sync (tenant_id, project_id, repo, cursor) VALUES (?, ?, 'api', 'cursor')").bind(w.tenant.id, made.project.id).run();
    ctx.env = {...env, ARTIFACTS_ACCOUNT_ID: "0".repeat(32), ARTIFACTS_API_TOKEN: "synthetic-test-token"};
    const replay = `git-push/${w.tenant.id}/${made.project.id}/cache-test`;
    await env.GIT_PUSH_STAGING!.put(replay, "pack");
    await env.HUB_DB.prepare("INSERT INTO git_push (id, tenant_id, project_id, namespace, repo, shadow, replay_key, updates_json, state, created_at) VALUES (?, ?, ?, 'acme', 'storage-api', ?, ?, '[]', 'complete', ?)").bind(crypto.randomUUID(), w.tenant.id, made.project.id, await validationRepository("storage-api"), replay, Date.now()).run();
    const temporary = vi.spyOn(ArtifactsRest.prototype, "deleteTemporary").mockRejectedValue(new Error("shared cache is not temporary"));
    const deletion = vi.spyOn(ArtifactsRest.prototype, "deleteProject").mockRejectedValueOnce(new Error("storage outage")).mockResolvedValue(undefined);
    try {
      await expect(projectDelete.run(ctx, projectDelete.parse({project: "tmp-repo"}))).rejects.toThrow("storage outage");
      expect((await env.HUB_DB.prepare("SELECT state FROM project WHERE id = ?").bind(made.project.id).first<any>())!.state).toBe("archived");
      const other = await seedAgent(w.tenant, w.admin.identity, "other");
      expect((await apiPost(w.host, "project.delete", {project: "tmp-repo"}, bearer(other.token))).status).toBe(403);
      expect(deletion).toHaveBeenCalledTimes(1);
      const result = await projectDelete.run(ctx, projectDelete.parse({project: "tmp-repo"}));
      expect(result.counts.repositories).toBe(3);
      expect(temporary).not.toHaveBeenCalled();expect(await env.GIT_PUSH_STAGING!.get(replay)).toBeNull();
      expect(deletion).toHaveBeenCalledWith("acme", "storage-api", `Pimwell tenant ${w.tenant.id} project ${made.project.id}`);
      expect(deletion).toHaveBeenCalledWith("acme", "storage-web", `Pimwell tenant ${w.tenant.id} project ${made.project.id}`);
      expect(await w.count("repository", "project_id", made.project.id)).toBe(0);
      expect(await w.count("repository_sync", "project_id", made.project.id)).toBe(0);
      expect(deletion).toHaveBeenCalledWith("acme", "tmp-repo", `Pimwell tenant ${w.tenant.id} project ${made.project.id}`);
      expect((await env.HUB_DB.prepare("SELECT kind, identity_id FROM event WHERE target_id = ?").bind(made.project.id).all()).results).toEqual([{kind: "project.deleted", identity_id: w.bot.agent.identity.id}]);
    } finally { deletion.mockRestore();temporary.mockRestore(); }
  });

  it("project_delete cleans proven incomplete forks without replay data, but refuses foreign metadata even with proof", async () => {
    const w = await world(), headers = bearer(w.bot.token);
    const ctx = await buildContext(new Request(`https://${w.host}/`, {headers}), env);
    const made = await projectCreate.run(ctx, projectCreate.parse({slug: "tmp-failed-fork", kind: "repo", display_name: "Failed fork"})) as {project: {id: string}};
    await env.HUB_DB.prepare("INSERT INTO git_repository (tenant_id, project_id, imported_at) VALUES (?, ?, ?)").bind(w.tenant.id, made.project.id, Date.now()).run();
    const account = "0".repeat(32), id = crypto.randomUUID(), temporary = `pimwell-stage-${id}`, cache = `pimwell-cache-${"b".repeat(40)}`, owner = `Pimwell tenant ${w.tenant.id} project ${made.project.id}`;
    ctx.env = {...env, ARTIFACTS_ACCOUNT_ID: account, ARTIFACTS_API_TOKEN: "synthetic-test-token"};
    await env.HUB_DB.prepare("INSERT INTO git_push (id, tenant_id, project_id, namespace, repo, shadow, replay_key, updates_json, state, created_at) VALUES (?, ?, ?, 'acme', 'tmp-failed-fork', ?, '', '[]', 'refused', ?)").bind(id, w.tenant.id, made.project.id, temporary, Date.now()).run();
    for (const [target, description] of [[temporary, `Pimwell temporary validation ${id}`], [cache, `${owner} validation cache for tmp-failed-fork`]]) {
      await env.HUB_DB.prepare("INSERT INTO artifact_fork_ownership VALUES (?, 'acme', ?, 'tmp-failed-fork', ?, 'reserved', ?)").bind(account, target, description, Date.now()).run();
    }
    let mismatch = true;
    const deleted: string[] = [];
    const fake = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = String(url).split("/").pop()!;
      if (init?.method === "DELETE") { deleted.push(target);return new Response(null, {status: 202}); }
      if (target === temporary && mismatch) return Response.json({success: true, result: {name: target, remote: `https://${account}.artifacts.cloudflare.net/git/acme/${target}.git`, description: "foreign"}});
      if (target === temporary || target === cache) return Response.json({errors: [{code: 10303}]}, {status: 409});
      if (target === "tmp-failed-fork") return Response.json({success: true, result: {name: target, remote: `https://${account}.artifacts.cloudflare.net/git/acme/${target}.git`, description: owner}});
      return new Response(null, {status: 404});
    });
    try {
      await expect(projectDelete.run(ctx, projectDelete.parse({project: "tmp-failed-fork"}))).rejects.toThrow("ownership mismatch");
      expect(deleted).toEqual([]);
      expect(await w.count("project", "id", made.project.id)).toBe(1);
      mismatch = false;
      const result = await projectDelete.run(ctx, projectDelete.parse({project: "tmp-failed-fork"}));
      expect(result.counts.repositories).toBe(1);
      expect(deleted).toEqual([temporary, cache, "tmp-failed-fork"]);
      expect(await w.count("project", "id", made.project.id)).toBe(0);
      // Durable tombstones outlive cascading D1 deletion so scheduled cleanup can reconcile 202.
      expect((await env.HUB_DB.prepare("SELECT proof FROM artifact_fork_ownership").all()).results).toEqual([{proof: "deleting"}, {proof: "deleting"}]);
    } finally { fake.mockRestore(); }
  });

  it("covers every D1 table with a project_id column, or a reasoned exemption", async () => {
    // Cloudflare's private _cf_ tables are inaccessible and contain platform metadata, not project content.
    const tables = (await env.HUB_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 4) <> '_cf_'").all<{ name: string }>()).results;
    const covered = new Set<string>([...PROJECT_DELETE_SCOPED_TABLES, ...PROJECT_DELETE_OTHER_TABLES]);
    const exempt: Record<string, string> = {}; // No project-bearing tables are currently exempt.
    for (const { name } of tables) {
      const columns = (await env.HUB_DB.prepare("SELECT name FROM pragma_table_info(?)").bind(name).all<{ name: string }>()).results;
      if (columns.some(c => c.name === "project_id")) {
        expect(covered.has(name) || !!exempt[name]?.trim(), `uncovered project table: ${name}`).toBe(true);
      }
    }
  });

  it("rolls back an impossible D1 cascade before purging conversations, inboxes, R2 or Artifacts", async () => {
    const w = await world(), db = env.HUB_DB;
    expect((await w.post("chat.post", { c: "gone-team", body: "Still intact" })).status).toBe(200);
    expect((await w.post("file.put", { project: "gone", path: "safe.txt", content_type: "text/plain", base64: btoa("safe"), expected_revision: 0 })).status).toBe(200);
    await w.post("project.archive", { slug: "gone" });
    const ch = await db.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = 'gone-team'").bind(w.tenant.id).first<{ id: string }>();
    const inbox = inboxStub(env, w.tenant.id, w.admin.identity.id);
    const before = await inbox.getUpdates(w.tenant.id, w.admin.identity.id, 0, 100, 0);
    const objects = await env.GIT_PUSH_STAGING!.list({ prefix: `project-files/${w.tenant.id}/${w.project.id}/` });
    // Emulate a future feature whose FK is absent from the deletion rules.
    await db.prepare("CREATE TABLE deletion_blocker (project_id TEXT REFERENCES project(id))").run();
    const artifacts = vi.spyOn(ArtifactsRest.prototype, "deleteProject");
    try {
      await db.prepare("INSERT INTO deletion_blocker VALUES (?)").bind(w.project.id).run();
      expect((await w.post("project.delete", { slug: "gone", confirm: "gone" })).status).toBe(500);
      expect(await w.count("project", "id", w.project.id)).toBe(1);
      expect(await w.count("file_revision", "project_id", w.project.id)).toBe(1);
      expect(await w.count("channel", "project_id", ch!.id)).toBe(1);
      expect(await w.count("msg_index", "conversation_id", ch!.id)).toBe(1);
      expect(await runInDurableObject(conversationStub(env, w.tenant.id, ch!.id), async (_, state) => ({
        deleted: state.storage.sql.exec("SELECT key FROM meta WHERE key = 'deleted'").toArray(),
        messages: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM artifact").one().n,
      }))).toEqual({ deleted: [], messages: 1 });
      expect(await inbox.getUpdates(w.tenant.id, w.admin.identity.id, 0, 100, 0)).toEqual(before);
      expect((await env.GIT_PUSH_STAGING!.list({ prefix: `project-files/${w.tenant.id}/${w.project.id}/` })).objects).toEqual(objects.objects);
      expect(artifacts).not.toHaveBeenCalled();
      expect((await db.prepare("SELECT 1 FROM event WHERE kind = 'project.delete'").all()).results).toEqual([]);
    } finally {
      artifacts.mockRestore();
      await db.prepare("DROP TABLE deletion_blocker").run();
    }
    expect((await w.post("project.delete", { slug: "gone", confirm: "gone" })).status).toBe(200);
  });

  it("creates, archives and confirms deletion with web forms; purges content, channels, objects and indexes without touching siblings or other tenants", async () => {
    const w = await world(), db = env.HUB_DB;
    expect(await w.get("/gone")).toContain('action="/api/project.archive"');
    expect(await w.get("/projects/new")).toContain('action="/api/project.create"');
    expect(await w.get("/gone", w.member.token)).not.toContain('action="/api/project.archive"');
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
      [`mail_actions:v1:${w.tenant.id}:${mailId}`, '{"status":"complete"}'],
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
    const privateChats = [];
    for (const kind of ["direct", "group"]) {
      const opened = await w.post("chat.open", { kind, members: [w.member.identity.id], client_id: `delete-check-${kind}` });
      expect(opened.status).toBe(200);
      const chat = (await opened.json() as any).result;
      privateChats.push(chat);
      expect((await w.post("chat.post", { c: chat.channel, body: "Keep private message" })).status).toBe(200);
    }
    const privateSnapshot = (await db.prepare("SELECT * FROM meta WHERE key GLOB ? OR key GLOB ?").bind(`private_chat:v1:${w.tenant.id}:*`, `private_open:v1:${w.tenant.id}:*`).all()).results;
    for (const p of [w.project, keep]) {
      for (const [id, kind] of [["person", "person"], ["company", "company"]]) {
        await db.prepare("INSERT INTO contact_entity (tenant_id, project_id, id, kind, name, data, updated_at) VALUES (?, ?, ?, ?, ?, '{}', ?)").bind(w.tenant.id, p.id, id!, kind!, id!, now).run();
      }
      await db.prepare("INSERT INTO contact_connection (tenant_id, project_id, id, a, b, type, source, date) VALUES (?, ?, 'connection', 'person', 'company', 'CEO', 'test', '2026-10-13')").bind(w.tenant.id, p.id).run();
      await db.prepare("INSERT INTO contact_link (tenant_id, project_id, entity_id, kind, ref) VALUES (?, ?, 'person', 'file', 'a.txt')").bind(w.tenant.id, p.id).run();
      for (const mode of ["share", "dispatch"]) {
        await db.prepare("INSERT INTO document_delivery (id, tenant_id, project_id, document_kind, document_ref, revision, recipient, sent_by, mode, status, created_at) VALUES (?, ?, ?, 'file', 'a.txt', 1, ?, ?, ?, 'sent', ?)").bind(`${mode}-${p.id}`, w.tenant.id, p.id, w.member.identity.id, w.admin.identity.id, mode, now).run();
      }
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
    for (const table of ["project", "contact_entity", "contact_connection", "contact_link", "document_delivery", "work_item", "wiki_revision", "file_revision", "file_upload", "inbound_mail", "channel", "review", "app_source", "app_deploy", "app_error_group", "code_sync", "code_event", "model_call"]) {
      expect(await w.count(table, table === "project" ? "id" : "project_id", w.project.id), table).toBe(0);
    }
    for (const table of ["work_comment", "work_link", "work_resource", "attention", "work_proposal"]) expect(await w.count(table, "item_id", item.id), table).toBe(0);
    for (const [table, column, id] of [["review_comment", "review_id", `review-${w.project.id}`], ["review_reviewer", "review_id", `review-${w.project.id}`], ["attention", "id", `attention-${w.project.id}`], ["app_event", "group_id", `group-${w.project.id}`], ["app_stat", "script_name", "script-gone"]]) expect(await w.count(table!, column!, id!), table).toBe(0);
    for (const table of ["review", "app_source", "app_deploy", "app_error_group", "code_sync", "code_event", "model_call", "file_upload"]) expect(await w.count(table, "project_id", keep.id), table).toBe(1);
    for (const table of ["contact_entity", "document_delivery"]) expect(await w.count(table, "project_id", keep.id)).toBe(2);
    for (const table of ["contact_connection", "contact_link"]) expect(await w.count(table, "project_id", keep.id)).toBe(1);
    expect((await db.prepare("SELECT * FROM meta WHERE key GLOB ? OR key GLOB ?").bind(`private_chat:v1:${w.tenant.id}:*`, `private_open:v1:${w.tenant.id}:*`).all()).results).toEqual(privateSnapshot);
    for (const chat of privateChats) {
      expect(await w.count("conversation_member", "conversation_id", chat.id)).toBe(2);
      expect(await w.count("msg_index", "conversation_id", chat.id)).toBe(1);
      expect((await w.post("chat.post", { c: chat.channel, body: "Private chat still works" })).status).toBe(200);
    }
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
    const updates = (await inbox.getUpdates(w.tenant.id, w.admin.identity.id, 0, 100, 0) as { updates: ChatUpdate[] }).updates;
    expect(updates.some(u => u.chat.id === ch!.id)).toBe(false);
    for (const chat of privateChats) expect(updates.some(u => u.chat.id === chat.id)).toBe(true);
    expect(await db.prepare("SELECT 1 FROM meta WHERE key = ?").bind(`mail_actions:v1:${w.tenant.id}:${mailId}`).first()).toBeNull();
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
    const base = await buildContext(new Request(`https://${w.host}/`, { headers: bearer(w.bot.token) }), env);
    const ctx = { ...base, agentMcp: { token_id: "test", scopes: ["read", "write"], sealed: { ciphertext: "", iv: "" } } };
    const result = await callTool(ctx, "project_delete", { project: "gone" });
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
    const pendingKey = `repo-provision:${w.tenant.id}:${made.project.id}`;
    await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, 'pending')").bind(pendingKey).run();
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
      expect(await env.HUB_DB.prepare("SELECT 1 FROM meta WHERE key = ?").bind(pendingKey).first()).toBeNull();
      expect((await env.HUB_DB.prepare("SELECT kind FROM event WHERE target_id = ?").bind(made.project.id).all()).results).toEqual([{ kind: "project.delete" }]);
    } finally { deletion.mockRestore(); }
  });
});
