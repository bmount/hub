import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { listEvents } from "../src/db/events";
import { getTenantBySlug } from "../src/db/tenants";
import { buildContext } from "../src/auth/context";
import { callTool } from "../src/mcp/tools";
import { wikiMarkdown } from "../src/http/wikiPages";

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
    expect((await apiPost("pimwell.test", "tenant.create", { slug: "blue", display_name: "Blue" }, bearer(admin.token))).status).toBe(403);
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
