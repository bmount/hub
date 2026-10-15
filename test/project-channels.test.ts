// Every new project gets #<project>-team and #<project>-ops; a name already taken is skipped, never an error.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { ASSETS } from "../src/assets";
import { createProject, getProjectByPath } from "../src/db/projects";
import { projectUpdate } from "../src/verbs/project";
import { toolsFor } from "../src/mcp/tools";
import { buildContext } from "../src/auth/context";
import { filePath, validateFile, putFile, PROJECT_FILE_BYTES, FILE_BYTES, FILE_TEXT_BYTES, BASE64_FILE_BYTES } from "../src/verbs/files";
import { redactUrl } from "../src/log";
import { PROJECT_FEATURES, projectFeatures, requireProjectFeature } from "../src/projectFeatures";
import { oauthContext } from "../src/auth/context";
import { liveGrant } from "../src/db/oauthGrants";
import { callTool } from "../src/mcp/tools";
import { registerAllVerbs } from "../src/verbs/index";
import { createChannel } from "../src/db/chat";
import { call, chatWorld, ok } from "./chat-helpers";
import { apiPost, bearer, cookieHeaders, seedGrant, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";

describe("project kinds", () => {
  it("defines all capabilities in one table", () => {
    expect(PROJECT_FEATURES).toEqual({ repo: ["docket", "repo", "files"], tracker: ["docket"], wiki: ["wiki", "files"], workspace: ["docket", "wiki", "knowledge", "files", "people"] });
    expect(projectFeatures({parts: "[]"})).toEqual([]);
    expect(() => requireProjectFeature({ slug: "docs", kind: "wiki" }, "repo")).toThrow("does not support Repository");
  });
  it("creates wiki and workspace over MCP and forms, with kind-specific tabs and feature errors", async () => {
    registerAllVerbs();
    const t = await seedTenant("acme");
    const h = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const { grant } = await seedGrant(t, h);
    const live = (await liveGrant(env.HUB_DB, grant.id, Date.now()))!;
    const ctx = oauthContext(env, live, ["read", "write"], { now: Date.now(), ip: "203.0.113.1" });
    for (const kind of ["wiki", "workspace"]) {
      const res = await callTool(ctx, "project_create", { slug: kind, kind, display_name: kind });
      expect(res.isError, JSON.stringify(res)).toBeUndefined();
      const form = await SELF.fetch(`https://${HOST}/api/project.create`, { method: "POST", redirect: "manual", headers: { ...cookieHeaders(h.token, HOST), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ slug: `${kind}-form`, kind, display_name: kind, _back: "@result" }).toString() });
      expect(form.status).toBe(303);
      expect(form.headers.get("location")).toBe(`/${kind}-form`);
      const html = await (await SELF.fetch(`https://${HOST}/${kind}`, { headers: cookieHeaders(h.token, HOST) })).text();
      const tabs = html.match(/<table class="wb-table" aria-label="Project contents">([\s\S]*?)<\/table>/)![1]!;
      expect(tabs).toContain("Wiki pages");
      expect(tabs).toContain("Files");
      expect(tabs).not.toContain("Repository");
      expect(tabs.includes("Open Wishes")).toBe(kind === "workspace");
      expect(tabs.includes("Research")).toBe(kind === "workspace");
      expect(tabs.includes("Contacts")).toBe(kind === "workspace");
      const repo = await callTool(ctx, "repo_branches", { project: kind });
      expect(repo.isError).toBe(true);
      expect(JSON.stringify(repo)).toContain("does not support Repository");
    }
    for (const name of ["work_list", "work_board", "work_frontier", "work_graph"]) {
      const res = await callTool(ctx, name, { project: "wiki" });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toContain("does not support Docket");
    }
    const form = await (await SELF.fetch(`https://${HOST}/projects/new`, { headers: cookieHeaders(h.token, HOST) })).text();
    for (const kind of Object.keys(PROJECT_FEATURES)) expect(form).toContain(`<option value="${kind}">`);
  });
});

describe("stored project parts", () => {
  async function world() {
    registerAllVerbs();
    const t = await seedTenant("acme");
    const h = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const { grant } = await seedGrant(t, h);
    const ctx = oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read", "write"], { now: Date.now(), ip: "203.0.113.1" });
    const p = await createProject(env.HUB_DB, {tenant_id:t.id, namespace_id:null, slug:"desk", kind:"tracker", display_name:"Desk"}, Date.now());
    const update = (args: Record<string, unknown>) => callTool(ctx, "project_update", {project:"desk", ...args});
    return {t,h,ctx,p,update};
  }
  it("seeds every template and uses stored parts for verbs, pages, search and discovery", async () => {
    const w = await world();
    for (const [kind, parts] of Object.entries(PROJECT_FEATURES)) {
      const p = await createProject(env.HUB_DB, {tenant_id:w.t.id, namespace_id:null, slug:kind, kind, display_name:kind}, Date.now());
      expect(projectFeatures((await getProjectByPath(env.HUB_DB,w.t.id,null,kind))!)).toEqual(parts);
      expect(projectFeatures(p)).toEqual(parts);
    }
    expect((await callTool(w.ctx,"wiki_list",{project:"desk"})).isError).toBe(true);
    expect((await w.update({add:["wiki","people","files","knowledge","wiki"]})).isError).toBeUndefined();
    expect((await callTool(w.ctx,"wiki_write",{project:"desk",slug:"page",title:"Needle",body:"needle stored parts",expected_revision:0,note:"test"})).isError).toBeUndefined();
    const stored = (await getProjectByPath(env.HUB_DB,w.t.id,null,"desk"))!;
    expect(stored.kind).toBe("tracker");
    w.ctx.mcpProject = {...stored,path:"desk"};
    const names = toolsFor(w.ctx).map(v=>v.name);
    expect(names).toContain("wiki.write");
    expect(names).toContain("project.update");
    expect(names).toContain("repo.create");
    expect(names).not.toContain("repo.log");
    const html = await (await SELF.fetch("https://" + HOST + "/desk",{headers:cookieHeaders(w.h.token,HOST)})).text();
    expect(html).toContain("Wiki pages");
    expect(html).toContain("Contacts");
    w.ctx.mcpProject = undefined;
    expect(JSON.stringify(await callTool(w.ctx,"search_query",{q:"needle"}))).toContain("desk/page");
    const remove = await w.update({remove:["wiki","knowledge"]});
    expect(remove.isError).toBe(true);
    expect(JSON.stringify(remove)).toContain("wiki revisions");
    expect((await w.update({remove:["people","knowledge","files"]})).isError).toBeUndefined();
    expect(projectFeatures((await getProjectByPath(env.HUB_DB,w.t.id,null,"desk"))!)).toEqual(["docket","wiki"]);
  });
  it("backfills templates plus existing repositories, including workspace code, from the migration", async () => {
    const w = await world();
    const p = await createProject(env.HUB_DB,{tenant_id:w.t.id,namespace_id:null,slug:"barefoot",kind:"workspace",display_name:"Barefoot"},Date.now());
    await env.HUB_DB.prepare("INSERT INTO repository (tenant_id,project_id,name,storage_name,is_default,created_at) VALUES (?,?,'default','owned-storage',1,?)").bind(w.t.id,p.id,Date.now()).run();
    await env.HUB_DB.prepare("UPDATE project SET parts = '[]' WHERE tenant_id = ?").bind(w.t.id).run();
    const migration = env.TEST_MIGRATIONS.find(m=>m.name.includes("0039"))!;
    for (const sql of migration.queries.filter(sql=>sql.trim().startsWith("UPDATE project"))) await env.HUB_DB.prepare(sql).run();
    expect(projectFeatures((await getProjectByPath(env.HUB_DB,w.t.id,null,"desk"))!)).toEqual(["docket"]);
    expect(projectFeatures((await getProjectByPath(env.HUB_DB,w.t.id,null,"barefoot"))!)).toEqual([...PROJECT_FEATURES.workspace,"repo"]);
  });
  it("refuses content-bearing parts and preserves content, including retained history", async () => {
    const w = await world();
    await w.update({add:["knowledge","files","people"]});
    const work = await callTool(w.ctx,"work_create",{project:"desk",kind:"errand",title:"Kept"});
    expect(work.isError).toBeUndefined();
    const contact = await callTool(w.ctx,"person_upsert",{project:"desk",name:"Kept person"});
    expect(contact.isError).toBeUndefined();
    const file = await callTool(w.ctx,"file_put",{project:"desk",path:"keep.txt",content_type:"text/plain",expected_revision:0,base64:Buffer.from("Kept").toString("base64")});
    expect(file.isError).toBeUndefined();
    const research = await callTool(w.ctx,"research_save",{project:"desk",slug:"study",expected_revision:0,topic:"Study",summary:"Kept research",status:"draft",sources:[],note:"test"});
    expect(research.isError).toBeUndefined();
    for (const [part,label] of [["docket","work items"],["people","contacts"],["files","file revisions"],["knowledge","research revisions"]]) {
      const removed = await w.update({remove:[part]});
      expect(removed.isError).toBe(true);
      expect(JSON.stringify(removed)).toContain(label);
    }
    expect((await apiPost(HOST,"project.update",{project:"desk",add:["wiki"]},bearer(w.h.token))).status).toBe(200);
    expect((await callTool(w.ctx,"file_get",{project:"desk",path:"keep.txt"})).isError).toBeUndefined();
    expect((await callTool(w.ctx,"research_list",{project:"desk"})).isError).toBeUndefined();
  });
  it("rejects invalid parts, readers, foreign tenants, pinned-project escapes and archived projects", async () => {
    const w = await world();
    for (const args of [{add:["unknown"]},{add:"wiki"},{add:["wiki"],remove:["wiki"]}]) expect((await w.update(args)).isError).toBe(true);
    w.ctx.role = "reader";
    expect((await w.update({add:["wiki"]})).isError).toBe(true);
    w.ctx.role = "member";
    const foreign = await seedTenant("elsewhere");
    const p = await createProject(env.HUB_DB,{tenant_id:foreign.id,namespace_id:null,slug:"foreign",kind:"tracker",display_name:"Foreign"},Date.now());
    expect((await w.update({project:p.slug,add:["wiki"]})).isError).toBe(true);
    w.ctx.mcpProject = {...w.p,path:"desk"};
    expect((await w.update({project:"foreign",add:["wiki"]})).isError).toBe(true);
    w.ctx.mcpProject = undefined;
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.p.id).run();
    expect((await w.update({add:["wiki"]})).isError).toBe(true);
    expect(projectFeatures((await getProjectByPath(env.HUB_DB,foreign.id,null,"foreign"))!)).toEqual(["docket"]);
    expect(() => projectUpdate.parse({project:"desk",remove:[null]})).toThrow();
  });
});

describe("project files", () => {
  async function world(role: "member" | "admin" = "member") {
    registerAllVerbs();
    const t = await seedTenant("acme");
    const h = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role }] });
    const p = await createProject(env.HUB_DB, {tenant_id: t.id, namespace_id: null, slug: "docs", kind: "workspace", display_name: "Docs"}, Date.now());
    const headers = cookieHeaders(h.token, HOST);
    const {grant} = await seedGrant(t, h);
    const ctx = oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read", "write"], {now: Date.now(), ip: "203.0.113.1"});
    const put = (text = "needle original", revision = 0, path = "notes/memo.md") => callTool(ctx, "file_put", {project: "docs", path, content_type: "text/markdown", expected_revision: revision, base64: Buffer.from(text).toString("base64")});
    return {t, p, h, headers, ctx, put};
  }
  it("uploads over MCP, versions with optimistic concurrency, lists folders, fetches bytes and searches current text", async () => {
    const w = await world();
    expect((await w.put()).isError).toBeUndefined();
    expect((await w.put("needle revised", 1)).isError).toBeUndefined();
    expect((await w.put("stale", 1)).isError).toBe(true);
    const list = (await callTool(w.ctx, "file_list", {project: "docs", folder: "notes"})).structuredContent as {files: Array<{revision: number; folder: string; size: number; sha256: string}>};
    expect(list.files).toHaveLength(1);
    expect(list.files[0]).toMatchObject({revision: 2, folder: "notes", size: 14, sha256: expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(JSON.stringify(list)).not.toContain("object_key");
    expect((await callTool(w.ctx, "file_list", {project: "docs", folder: "not"})).structuredContent).toMatchObject({files: []});
    const get = (await callTool(w.ctx, "file_get", {project: "docs", path: "notes/memo.md", revision: 1, include_base64: true})).structuredContent as {base64: string};
    expect(Buffer.from(get.base64, "base64").toString()).toBe("needle original");
    const history = (await callTool(w.ctx, "file_history", {project: "docs", path: "notes/memo.md"})).structuredContent as {history: Array<{revision: number}>};
    expect(history.history.map(r => r.revision)).toEqual([2,1]);
    const search = await callTool(w.ctx, "search_query", {q: "revised"});
    expect(search.structuredContent).toMatchObject({files: [expect.objectContaining({title: "memo.md", snippet: "needle revised"})]});
    expect((await callTool(w.ctx, "search_query", {q: "original"})).structuredContent).toMatchObject({files: []});
    const page = await (await SELF.fetch(`https://${HOST}/docs/documents?path=notes%2Fmemo.md`, {headers: w.headers})).text();
    expect(page).not.toContain("Version 1");
    expect(page).toContain("modified ");
    expect(page).toContain("by ");
    expect(page).toContain("Download");
    expect(page).not.toContain("SHA-256");
    expect(page).toContain('href="/docs/documents?upload=1"');
    const upload = await (await SELF.fetch(`https://${HOST}/docs/documents?upload=1`,{headers:w.headers})).text();
    expect(upload).toContain('enctype="multipart/form-data"');
  });
  it("uploads multipart web files and returns safe authenticated downloads, with tenant/project isolation", async () => {
    const w = await world();
    const fd = new FormData();
    fd.set("file", new File(["csvneedle,value"], "sheet.csv", {type: "text/csv"})); fd.set("expected_revision", "0");
    const res = await SELF.fetch(`https://${HOST}/docs/documents/upload`, {method: "POST", headers: w.headers, body: fd, redirect: "manual"});
    expect(res.status, await res.clone().text()).toBe(303);
    const url = `https://${HOST}/docs/documents/download?path=sheet.csv`;
    const download = await SELF.fetch(url, {headers: w.headers});
    expect(download.status).toBe(200); expect(await download.text()).toBe("csvneedle,value");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("cache-control")).toContain("no-store");
    expect((await SELF.fetch(url)).status).toBe(404);
    await createProject(env.HUB_DB, {tenant_id: w.t.id, namespace_id: null, slug: "elsewhere", kind: "wiki", display_name: "Else"}, Date.now());
    expect((await SELF.fetch(url.replace("/docs/", "/elsewhere/"), {headers: w.headers})).status).toBe(404);
    const foreign = await seedTenant("foreign");
    await createProject(env.HUB_DB, {tenant_id: foreign.id, namespace_id: null, slug: "docs", kind: "wiki", display_name: "Docs"}, Date.now());
    const outsider = await seedHuman("other@example.com", {memberships: [{tenant_id: foreign.id, role: "member"}]});
    expect((await SELF.fetch(url.replace(HOST, "foreign.pimwell.test"), {headers: cookieHeaders(outsider.token, "foreign.pimwell.test")})).status).toBe(404);
    const search = await apiPost("foreign.pimwell.test", "search.query", {q: "csvneedle"}, cookieHeaders(outsider.token, "foreign.pimwell.test"));
    expect(await search.json()).toMatchObject({result: {files: []}});
    const evil = new FormData(); evil.set("file", new File(["evil"], "a.txt", {type: "text/plain"})); evil.set("expected_revision", "0");
    expect((await SELF.fetch(`https://${HOST}/docs/documents/upload`, {method: "POST", headers: {...w.headers, origin: "https://evil.test"}, body: evil})).status).toBe(403);
  });
  it("consumes upload capabilities once, pins tenant/project/identity, expires, and checks Content-Type", async () => {
    const w = await world();
    const mint = async () => {
      const res = await apiPost(HOST, "file.upload_url", {project: "docs", path: "big.txt", content_type: "text/plain", expected_revision: 0}, w.headers);
      expect(res.status).toBe(200);
      return (await res.json() as {result: {upload_url: string}}).result.upload_url;
    };
    const url = await mint();
    expect(redactUrl(new URL(url))).not.toContain(new URL(url).searchParams.get("token"));
    const other = await seedHuman("other@example.com", {memberships: [{tenant_id: w.t.id, role: "member"}]});
    expect((await SELF.fetch(url, {method: "PUT", headers: {...cookieHeaders(other.token, HOST), "content-type": "text/plain"}, body: "wrong"})).status).toBe(404);
    expect((await SELF.fetch(url.replace("/docs/", "/absent/"), {method: "PUT", headers: {...w.headers, "content-type": "text/plain"}, body: "wrong"})).status).toBe(404);
    const res = await SELF.fetch(url, {method: "PUT", headers: {...w.headers, "content-type": "text/plain"}, body: "x".repeat(BASE64_FILE_BYTES + 1)});
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await SELF.fetch(url, {method: "PUT", headers: {...w.headers, "content-type": "text/plain"}, body: "repeat"})).status).toBe(404);
    expect((await callTool(w.ctx, "file_get", {project: "docs", path: "big.txt", include_base64: true})).isError).toBe(true);
    const expired = await mint();
    await env.HUB_DB.prepare("UPDATE file_upload SET expires_at = 0").run();
    expect((await SELF.fetch(expired, {method: "PUT", headers: {...w.headers, "content-type": "text/plain"}, body: "bad"})).status).toBe(404);
    const mismatch = await mint();
    expect((await SELF.fetch(mismatch, {method: "PUT", headers: {...w.headers, "content-type": "text/html"}, body: "bad"})).status).toBe(400);
    expect((await SELF.fetch(mismatch, {method: "PUT", headers: {...w.headers, "content-type": "text/plain"}, body: "bad"})).status).toBe(404);
  });
  it("checks file/base64/text/type limits, enforces quota atomically, and scopes optional links", async () => {
    const w = await world();
    for (const path of ["../secret.txt", "/a.txt", "a/../b.txt", "a\\b.txt", "a//b.txt"]) expect(() => filePath(path)).toThrow();
    expect(() => validateFile("a.html", "text/html", new TextEncoder().encode("<script>"))).toThrow();
    expect(() => validateFile("a.svg", "image/svg+xml", new Uint8Array())).toThrow();
    expect(() => validateFile("a.pdf", "application/pdf", new TextEncoder().encode("<html>"))).toThrow();
    expect(() => validateFile("a.txt", "text/plain", new Uint8Array([255]))).toThrow();
    expect(() => validateFile("a.txt", "text/plain", new Uint8Array(FILE_BYTES + 1))).toThrow();
    expect(validateFile("a.txt", "text/plain", new TextEncoder().encode("x".repeat(FILE_TEXT_BYTES + 100))).text.length).toBe(FILE_TEXT_BYTES);
    expect((await w.put("x".repeat(BASE64_FILE_BYTES + 1))).isError).toBe(true);
    const invalid = await callTool(w.ctx, "file_put", {project: "docs", path: "a.txt", content_type: "text/plain", expected_revision: 0, base64: "not base64"});
    expect(invalid.isError).toBe(true);
    expect((await w.put()).isError).toBeUndefined();
    await env.HUB_DB.prepare("UPDATE file_revision SET size = ? WHERE tenant_id = ?").bind(PROJECT_FILE_BYTES - 5, w.t.id).run();
    const results = await Promise.all([w.put("abc", 0, "first.md"), w.put("abc", 0, "second.md")]);
    expect(results.filter(r => !r.isError)).toHaveLength(1);
    expect((await w.put("sixsix", 1)).isError).toBe(true);
    const foreign = await seedTenant("foreign");
    const person = await seedHuman("foreign@example.com", {memberships: [{tenant_id: foreign.id, role: "member"}]});
    const ctx = await buildContext(new Request(`https://${HOST}/`, {headers: w.headers}), env);
    await expect(putFile(ctx, {project: "docs", path: "person.txt", content_type: "text/plain", expected_revision: 0, item_id: null, person_id: person.identity.id}, new Uint8Array())).rejects.toThrow("no such organization person");
    await expect(putFile(ctx, {project: "docs", path: "item.txt", content_type: "text/plain", expected_revision: 0, item_id: "nonexistent", person_id: null}, new Uint8Array())).rejects.toThrow("no such project item");
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.p.id).run();
    expect((await w.put("new", 1)).isError).toBe(true);
  });
  it("allows inline raster/PDF only and gates delete to admins while retaining quota/history", async () => {
    const w = await world("admin");
    const pdf = await callTool(w.ctx, "file_put", {project: "docs", path: "a.pdf", content_type: "application/pdf", expected_revision: 0, base64: Buffer.from("%PDF-1.4\n").toString("base64")});
    expect(pdf.isError).toBeUndefined();
    const res = await SELF.fetch(`https://${HOST}/docs/documents/download?path=a.pdf`, {headers: w.headers});
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    const reader = await seedHuman("reader@example.com", {memberships: [{tenant_id: w.t.id, role: "reader"}]});
    expect((await apiPost(HOST, "file.put", {}, cookieHeaders(reader.token, HOST))).status).toBe(403);
    const member = await seedHuman("member@example.com", {memberships: [{tenant_id: w.t.id, role: "member"}]});
    expect((await apiPost(HOST, "file.delete", {project: "docs", path: "a.pdf"}, cookieHeaders(member.token, HOST))).status).toBe(403);
    expect((await callTool(w.ctx, "file_delete", {project: "docs", path: "a.pdf"})).isError).toBeUndefined();
    expect((await callTool(w.ctx, "file_get", {project: "docs", path: "a.pdf", revision: 1})).isError).toBe(true);
    expect((await callTool(w.ctx, "file_list", {project: "docs"})).structuredContent).toMatchObject({files: []});
    expect((await callTool(w.ctx, "file_history", {project: "docs", path: "a.pdf"})).structuredContent).toMatchObject({history: [expect.objectContaining({deleted: 1})]});
  });
});

describe("workspace research", () => {
  async function world() {
    registerAllVerbs();
    const t = await seedTenant("acme");
    const h = await seedHuman("pat@example.com", {memberships: [{tenant_id: t.id, role: "member"}]});
    await createProject(env.HUB_DB, {tenant_id: t.id, namespace_id: null, slug: "lab", kind: "workspace", display_name: "Lab"}, Date.now());
    const {grant} = await seedGrant(t, h);
    const ctx = oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read", "write"], {now: Date.now(), ip: "203.0.113.1"});
    const item = (await callTool(ctx, "work_create", {project: "lab", kind: "errand", title: "Read research", body: ""})).structuredContent as {item: {number: number}};
    const input = {project: "lab", slug: "findings", expected_revision: 0, topic: "Needle topic", summary: "Evidence summary", status: "draft", sources: [{url: "https://example.com/one", title: "First source", retrieved_at: "2026-10-12T00:00:00Z", quote: "quotedneedle"}, {url: "https://example.com/two", title: "Second source", retrieved_at: "2026-10-12T00:00:00Z", quote: "Another quote"}], people: [h.identity.id], orgs: ["Example organization"], items: [`lab#${item.item.number}`], note: "File research"};
    return {t, h, ctx, input, headers: cookieHeaders(h.token, HOST)};
  }
  it("saves over MCP in wiki history, filters, renders on workspace/page and searches all source text", async () => {
    const w = await world();
    const saved = await callTool(w.ctx, "research_save", w.input);
    expect(saved.isError, JSON.stringify(saved)).toBeUndefined();
    const list = (await callTool(w.ctx, "research_list", {project: "lab", topic: "needle", person: w.h.identity.id, org: "Example organization", status: "draft"})).structuredContent;
    expect(list).toMatchObject({results: [expect.objectContaining({sources: w.input.sources, people: w.input.people, items: w.input.items, author_id: w.h.identity.id, revision: 1})]});
    for (const filter of [{topic: "absent"}, {org: "absent"}, {person: "absent"}, {status: "final"}, {after: "zzzz"}]) expect((await callTool(w.ctx, "research_list", {project: "lab", ...filter})).structuredContent).toMatchObject({results: []});
    const home = await (await SELF.fetch(`https://${HOST}/lab`, {headers: w.headers})).text();
    expect(home).toContain('href="/lab?resource=research"');
    const researchPane = await (await SELF.fetch(`https://${HOST}/lab?resource=research`, {headers: w.headers})).text();
    expect(researchPane).toContain("Needle topic");
    const page = await (await SELF.fetch(`https://${HOST}/lab/wiki/findings`, {headers: w.headers})).text();
    expect(page).toContain("First source"); expect(page).toContain("Second source"); expect(page).toContain('href="/lab/w/1"'); expect(page).not.toContain('action="/api/wiki.write"');
    expect((await callTool(w.ctx, "search_query", {q: "quotedneedle"})).structuredContent).toMatchObject({wiki: [expect.objectContaining({ref: "lab/findings"})]});
    expect((await callTool(w.ctx, "wiki_write", {project: "lab", slug: "findings", expected_revision: 1, title: "overwrite", body: "", note: "bad"})).isError).toBe(true);
    expect((await callTool(w.ctx, "research_save", {...w.input, expected_revision: 1, summary: "New summary", status: "final"})).isError).toBeUndefined();
    expect((await callTool(w.ctx, "research_save", {...w.input, expected_revision: 1})).isError).toBe(true);
    expect((await callTool(w.ctx, "wiki_read", {project: "lab", slug: "findings", revision: 1})).structuredContent).toMatchObject({page: {author_id: w.h.identity.id, research: expect.stringContaining("quotedneedle")}});
    expect((await callTool(w.ctx, "wiki_history", {project: "lab", slug: "findings"})).structuredContent).toMatchObject({history: [expect.objectContaining({revision: 2}), expect.objectContaining({revision: 1})]});
  });
  it("validates fields, references, role, archived workspaces and tenant isolation", async () => {
    const w = await world();
    for (const change of [{sources: [{...w.input.sources[0], url: "javascript:alert(1)"}]}, {sources: [{...w.input.sources[0], retrieved_at: "yesterday"}]}, {sources: [{...w.input.sources[0], file: "a.txt"}]}, {sources: [{file: "missing.txt", title: "Missing", retrieved_at: "2026-10-12T00:00:00Z", quote: "quote"}]}, {items: ["lab#999"]}, {people: ["missing"]}, {status: "invalid"}, {expected_revision: undefined}]) expect((await callTool(w.ctx, "research_save", {...w.input, ...change})).isError).toBe(true);
    const foreign = await seedTenant("foreign");
    const other = await seedHuman("other@example.com", {memberships: [{tenant_id: foreign.id, role: "member"}]});
    expect((await callTool(w.ctx, "research_save", {...w.input, people: [other.identity.id]})).isError).toBe(true);
    expect((await callTool(w.ctx, "research_save", w.input)).isError).toBeUndefined();
    expect((await SELF.fetch(`https://foreign.pimwell.test/lab/wiki/findings`, {headers: cookieHeaders(other.token, "foreign.pimwell.test")})).status).toBe(404);
    const reader = await seedHuman("reader@example.com", {memberships: [{tenant_id: w.t.id, role: "reader"}]});
    expect((await apiPost(HOST, "research.save", w.input, cookieHeaders(reader.token, HOST))).status).toBe(403);
    await createProject(env.HUB_DB, {tenant_id: w.t.id, namespace_id: null, slug: "guide", kind: "wiki", display_name: "Guide"}, Date.now());
    expect((await callTool(w.ctx, "research_list", {project: "guide"})).isError).toBe(true);
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE tenant_id = ? AND slug = 'lab'").bind(w.t.id).run();
    expect((await callTool(w.ctx, "research_save", {...w.input, expected_revision: 1})).isError).toBe(true);
  });
});

describe("workspace contacts", () => {
  async function world() {
    registerAllVerbs();
    const t = await seedTenant("acme");
    const h = await seedHuman("pat@example.com", {memberships: [{tenant_id: t.id, role: "member"}]});
    const p = await createProject(env.HUB_DB, {tenant_id: t.id, namespace_id: null, slug: "fund", kind: "workspace", display_name: "Fund"}, Date.now());
    const {grant} = await seedGrant(t, h);
    const ctx = oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read", "write"], {now: Date.now(), ip: "203.0.113.1"});
    const call = async (name: string, input: Record<string, unknown>) => {
      const r = await callTool(ctx, name, {project: "fund", ...input});
      expect(r.isError, JSON.stringify(r)).toBeUndefined();
      return r.structuredContent as {entity: {id: string; revision: number}; connection: {id: string}};
    };
    return {t, h, p, ctx, call, headers: cookieHeaders(h.token, HOST)};
  }
  it("creates people/companies and typed edges over MCP, finds shortest 2-hop intros and renders an escaped interactive graph", async () => {
    const w = await world();
    const a = (await w.call("person_upsert", {name: "Contactneedle <script>alert(1)</script>", emails: ["founder@example.com"], phones: ["+1 555 0100"], title: "Founder", tags: ["portfolio"], notes: "Researchneedle"})).entity;
    const b = (await w.call("person_upsert", {name: "Introducer"})).entity;
    const c = (await w.call("company_upsert", {name: "Companyneedle", domain: "example.com", stage: "seed", sector: "health", tags: ["portfolio"]})).entity;
    const orphan = (await w.call("person_upsert", {name: "Disconnected"})).entity;
    await w.call("connection_add", {a: a.id, b: b.id, type: "knows", strength: 0.8, source: "Research note", date: "2026-10-13"});
    const edge = (await w.call("connection_add", {a: b.id, b: c.id, type: "founder"})).connection;
    expect((await callTool(w.ctx, "graph_path", {project: "fund", from: a.id, to: c.id})).structuredContent).toMatchObject({found: true, hops: 2, nodes: [{id: a.id}, {id: b.id}, {id: c.id}], connections: [{type: "knows"}, {type: "founder"}]});
    expect((await callTool(w.ctx, "graph_path", {project: "fund", from: c.id, to: a.id})).structuredContent).toMatchObject({found: true, hops: 2});
    expect((await callTool(w.ctx, "graph_path", {project: "fund", from: a.id, to: a.id})).structuredContent).toMatchObject({found: true, hops: 0});
    for (const change of [{to: orphan.id}, {to: c.id, type: "knows"}]) expect((await callTool(w.ctx, "graph_path", {project: "fund", from: a.id, ...change})).structuredContent).toMatchObject({found: false, hops: null, nodes: []});
    expect((await callTool(w.ctx, "graph_neighbors", {project: "fund", id: a.id, hops: 2})).structuredContent).toMatchObject({nodes: [expect.objectContaining({id: a.id, depth: 0}), expect.objectContaining({id: b.id, depth: 1}), expect.objectContaining({id: c.id, depth: 2})]});
    for (const [name, args] of [["person_list", {tag: "portfolio"}], ["company_list", {q: "company"}]] as const) expect((await callTool(w.ctx, name, {project: "fund", ...args})).structuredContent).toMatchObject({entities: [expect.objectContaining({tags: ["portfolio"]})]});
    expect((await callTool(w.ctx, "person_list", {project: "fund", after: "zzzz"})).structuredContent).toMatchObject({entities: []});
    expect((await callTool(w.ctx, "connection_list", {project: "fund", entity: b.id})).structuredContent).toMatchObject({connections: [expect.objectContaining({type: "knows"}), expect.objectContaining({type: "founder"})]});
    expect((await callTool(w.ctx, "search_query", {q: "researchneedle"})).structuredContent).toMatchObject({contacts: [expect.objectContaining({title: expect.stringContaining("Contactneedle"), href: `/fund/contacts/${a.id}`})]});
    const page = await SELF.fetch(`https://${HOST}/fund/contacts/${a.id}?hops=2&view=graph`, {headers: w.headers});
    const html = await page.text();
    expect(page.status).toBe(200); expect(html).toContain("data-contact-graph"); expect(html).toContain("<svg"); expect(html).toContain(`src="${ASSETS.graph.path}"`); expect(html).toContain("Companyneedle"); expect(html).not.toContain("<script>alert(1)</script>");
    expect((await SELF.fetch(`https://${HOST}${ASSETS.graph.path}`)).headers.get("content-type")).toContain("javascript");
    const list = await (await SELF.fetch(`https://${HOST}/fund/contacts`, {headers: w.headers})).text();
    expect(list).toContain("Introducer"); expect(list).toContain('href="/fund/contacts?new=1"');
    const create = await (await SELF.fetch(`https://${HOST}/fund/contacts?new=1`,{headers:w.headers})).text();
    expect(create).toContain('action="/api/person.upsert"');
    const home = await (await SELF.fetch(`https://${HOST}/fund`, {headers: w.headers})).text(); expect(home).toContain('href="/fund/contacts"');
    await w.call("connection_remove", {id: edge.id});
    expect((await callTool(w.ctx, "graph_path", {project: "fund", from: a.id, to: c.id})).structuredContent).toMatchObject({found: false});
  });
  it("links items, research, files and readable mail and preserves mailbox boundaries on read and edits", async () => {
    const w = await world();
    const item = (await callTool(w.ctx, "work_create", {project: "fund", kind: "errand", title: "Entity evidence"})).structuredContent as {item: {id: string}};
    await w.call("research_save", {slug: "finding", expected_revision: 0, topic: "Research evidence", summary: "Evidence", status: "draft", sources: [], note: "Save"});
    await w.call("file_put", {path: "memo.txt", content_type: "text/plain", expected_revision: 0, base64: Buffer.from("Evidence").toString("base64")});
    for (const [id, recipient] of [["SHARED", null], ["PRIVATE", w.h.identity.id]] as const) await env.HUB_DB.prepare("INSERT INTO inbound_mail (id, tenant_id, recipient_id, identity_id, from_email, to_address, subject, received_at, size, verdict, text, attachments, forwarded) VALUES (?, ?, ?, ?, 'a@example.com', 'acme@pimwell.test', ?, ?, 1, 'admitted', 'Evidence', '[]', 0)").bind(id, w.t.id, recipient, w.h.identity.id, `${id} evidence`, Date.now()).run();
    const links = [{kind: "item", ref: item.item.id}, {kind: "research", ref: "finding"}, {kind: "file", ref: "memo.txt"}, {kind: "mail", ref: "SHARED"}, {kind: "mail", ref: "PRIVATE"}];
    const a = (await w.call("person_upsert", {name: "Linked", links})).entity;
    const read = await callTool(w.ctx, "person_read", {project: "fund", id: a.id});
    expect(read.structuredContent).toMatchObject({backlinks: expect.arrayContaining(links.map(l => expect.objectContaining(l)))});
    const other = await seedHuman("other@example.com", {memberships: [{tenant_id: w.t.id, role: "member"}]});
    const headers = cookieHeaders(other.token, HOST);
    const result = await apiPost(HOST, "person.read", {project: "fund", id: a.id}, headers);
    expect(await result.text()).not.toContain("PRIVATE");
    expect(await (await SELF.fetch(`https://${HOST}/fund/contacts/${a.id}`, {headers})).text()).not.toContain("PRIVATE");
    expect((await apiPost(HOST, "person.upsert", {project: "fund", id: a.id, expected_revision: 1, name: "Linked", links: [{kind: "mail", ref: "PRIVATE"}]}, headers)).status).toBe(404);
    expect((await apiPost(HOST, "person.upsert", {project: "fund", id: a.id, expected_revision: 1, name: "Linked", links: []}, headers)).status).toBe(200);
    expect((await callTool(w.ctx, "person_read", {project: "fund", id: a.id})).structuredContent).toMatchObject({backlinks: [{kind: "mail", ref: "PRIVATE"}]});
    for (const link of [{kind: "item", ref: "missing"}, {kind: "research", ref: "missing"}, {kind: "file", ref: "../a"}, {kind: "mail", ref: "missing"}]) expect((await callTool(w.ctx, "person_upsert", {project: "fund", name: "Invalid", links: [link]})).isError).toBe(true);
  });
  it("merges person data, connections and backlinks atomically and rejects stale edits without changing links", async () => {
    const w = await world();
    const a = (await w.call("person_upsert", {name: "Source", emails: ["one@example.com"], tags: ["a"], notes: "First"})).entity;
    const b = (await w.call("person_upsert", {name: "Target", emails: ["two@example.com"], tags: ["b"], notes: "Second"})).entity;
    const c = (await w.call("company_upsert", {name: "Company"})).entity;
    await w.call("connection_add", {a: a.id, b: b.id, type: "knows"});
    await w.call("connection_add", {a: a.id, b: c.id, type: "founder"});
    const item = (await callTool(w.ctx, "work_create", {project: "fund", kind: "errand", title: "Linked"})).structuredContent as {item: {id: string}};
    await w.call("person_upsert", {id: a.id, expected_revision: 1, name: "Source", emails: ["one@example.com"], tags: ["a"], notes: "First", links: [{kind: "item", ref: item.item.id}]});
    expect((await callTool(w.ctx, "person_upsert", {project: "fund", id: a.id, expected_revision: 1, name: "Stale", links: []})).isError).toBe(true);
    expect((await callTool(w.ctx, "person_read", {project: "fund", id: a.id})).structuredContent).toMatchObject({entity: {name: "Source", revision: 2}, backlinks: [{ref: item.item.id}]});
    expect((await callTool(w.ctx, "person_merge", {project: "fund", from: a.id, into: b.id, from_revision: 1, into_revision: 1})).isError).toBe(true);
    await w.call("person_merge", {from: a.id, into: b.id, from_revision: 2, into_revision: 1});
    expect((await callTool(w.ctx, "person_read", {project: "fund", id: b.id})).structuredContent).toMatchObject({entity: {name: "Target", revision: 2, emails: ["two@example.com", "one@example.com"], tags: ["b", "a"], notes: "Second\n\nFirst"}, backlinks: [{ref: item.item.id}]});
    expect((await callTool(w.ctx, "person_read", {project: "fund", id: a.id})).isError).toBe(true);
    expect((await callTool(w.ctx, "connection_list", {project: "fund"})).structuredContent).toMatchObject({connections: [{a: b.id, b: c.id, type: "founder"}]});
    const races = await Promise.all([1, 2].map(n => callTool(w.ctx, "person_upsert", {project: "fund", id: b.id, expected_revision: 2, name: `Race ${n}`})));
    expect(races.filter(r => !r.isError)).toHaveLength(1);
  });
  it("enforces tenant isolation, reader/member roles, workspace scope, archived writes and input bounds", async () => {
    const w = await world();
    const a = (await w.call("person_upsert", {name: "Tenantsecret"})).entity;
    const c = (await w.call("company_upsert", {name: "Tenantcompany"})).entity;
    const edge = (await w.call("connection_add", {a: a.id, b: c.id, type: "founder"})).connection;
    const foreign = await seedTenant("foreign");
    await createProject(env.HUB_DB, {tenant_id: foreign.id, namespace_id: null, slug: "fund", kind: "workspace", display_name: "Other Fund"}, Date.now());
    const outsider = await seedHuman("outsider@example.com", {memberships: [{tenant_id: foreign.id, role: "member"}]});
    const fh = cookieHeaders(outsider.token, "foreign.pimwell.test");
    for (const [verb, input] of [["person.read", {id: a.id}], ["company.read", {id: c.id}], ["graph.neighbors", {id: a.id}], ["graph.path", {from: a.id, to: c.id}], ["connection.add", {a: a.id, b: c.id, type: "knows"}], ["connection.remove", {id: edge.id}], ["person.merge", {from: a.id, into: c.id, from_revision: 1, into_revision: 1}], ["person.upsert", {id: a.id, expected_revision: 1, name: "Overwrite"}]] as const) expect((await apiPost("foreign.pimwell.test", verb, {project: "fund", ...input}, fh)).status, verb).toBe(404);
    for (const [verb, key] of [["person.list", "entities"], ["company.list", "entities"], ["connection.list", "connections"]] as const) expect(await (await apiPost("foreign.pimwell.test", verb, {project: "fund"}, fh)).json()).toMatchObject({result: {[key]: []}});
    expect(await (await apiPost("foreign.pimwell.test", "search.query", {q: "tenantsecret"}, fh)).json()).toMatchObject({result: {contacts: []}});
    for (const path of ["/fund/contacts", `/fund/contacts/${a.id}`]) {
      expect((await SELF.fetch(`https://${HOST}${path}`)).status).toBe(404);
      expect((await SELF.fetch(`https://${HOST}${path}`, {headers: fh})).status).toBe(404);
    }
    expect((await SELF.fetch(`https://foreign.pimwell.test/fund/contacts/${a.id}`, {headers: fh})).status).toBe(404);
    const reader = await seedHuman("reader@example.com", {memberships: [{tenant_id: w.t.id, role: "reader"}]});
    const rh = cookieHeaders(reader.token, HOST);
    expect((await apiPost(HOST, "person.read", {project: "fund", id: a.id}, rh)).status).toBe(200);
    for (const verb of ["person.upsert", "company.upsert", "person.merge", "connection.add", "connection.remove"]) expect((await apiPost(HOST, verb, {}, rh)).status).toBe(403);
    expect(await (await SELF.fetch(`https://${HOST}/fund/contacts`, {headers: rh})).text()).not.toContain('action="/api/person.upsert"');
    await createProject(env.HUB_DB, {tenant_id: w.t.id, namespace_id: null, slug: "other", kind: "workspace", display_name: "Other"}, Date.now());
    expect((await callTool(w.ctx, "person_read", {project: "other", id: a.id})).isError).toBe(true);
    await createProject(env.HUB_DB, {tenant_id: w.t.id, namespace_id: null, slug: "wiki", kind: "wiki", display_name: "Wiki"}, Date.now());
    expect((await callTool(w.ctx, "person_list", {project: "wiki"})).isError).toBe(true);
    for (const input of [{a: a.id, b: a.id}, {a: a.id, b: "missing"}, {a: a.id, b: c.id, strength: 2}, {a: a.id, b: c.id, date: "2026-02-30"}]) expect((await callTool(w.ctx, "connection_add", {project: "fund", type: "knows", ...input})).isError).toBe(true);
    expect((await callTool(w.ctx, "graph_neighbors", {project: "fund", id: a.id, hops: 7})).isError).toBe(true);
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.p.id).run();
    expect((await callTool(w.ctx, "person_upsert", {project: "fund", name: "New"})).isError).toBe(true);
    expect((await callTool(w.ctx, "connection_remove", {project: "fund", id: edge.id})).isError).toBe(true);
    expect((await callTool(w.ctx, "person_read", {project: "fund", id: a.id})).isError).toBeUndefined();
    const count = await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM membership WHERE tenant_id = ?").bind(w.t.id).first<{n: number}>(); expect(count!.n).toBe(2);
  });
});

describe("default project channels", () => {
  it("grants only the workspace creator newly generated channels, never existing channels or self-joins", async () => {
    const w = await chatWorld();
    registerAllVerbs();
    await ok(w.lead.token, "channel.create", { slug: "lab-ops" });
    const created = await ok(w.scout.token, "project.create", { slug: "lab", kind: "workspace", display_name: "Lab", identity_id: w.tidy.agent.identity.id });
    expect(created.channels).toEqual(["lab-team"]);
    expect(JSON.stringify(await ok(w.scout.token, "chat.conversations"))).toContain("lab-team");
    expect(JSON.stringify(await ok(w.scout.token, "chat.conversations"))).not.toContain("lab-ops");
    expect(JSON.stringify(await ok(w.tidy.token, "chat.conversations"))).not.toContain("lab-team");
    for (const [token, c] of [[w.scout.token, "lab-ops"], [w.tidy.token, "lab-team"]]) {
      expect((await call(token!, "chat.read", { c })).status).toBe(404);
      expect((await call(token!, "chat.post", { c, body: "denied", after: 0 })).status).toBe(404);
    }
    const post = await ok(w.scout.token, "chat.post", { c: "lab-team", body: "Creator hello", after: 0 });
    expect((await ok(w.scout.token, "chat.read", { c: "lab-team" })).messages).toHaveLength(1);
    const members = await env.HUB_DB.prepare("SELECT identity_id, added_by FROM conversation_member WHERE tenant_id = ?").bind(w.acme.id).all();
    expect(members.results).toEqual([{ identity_id: w.scout.agent.identity.id, added_by: w.scout.agent.identity.id }]);
    await ok(w.lead.token, "channel.set_agent_policy", { c: "lab-team", policy: "muted" });
    expect((await call(w.scout.token, "chat.post", { c: "lab-team", body: "muted", after: post.head })).status).toBe(403);
    await ok(w.lead.token, "channel.remove_agent", { c: "lab-team", agent: "scout" });
    expect((await call(w.scout.token, "project.create", { slug: "lab", kind: "workspace", display_name: "Lab" })).status).toBe(409);
    expect((await call(w.scout.token, "channel.add_agent", { c: "lab-team", agent: "scout" })).status).toBe(403);
    expect((await call(w.scout.token, "chat.read", { c: "lab-team" })).status).toBe(404);
    const base = await buildContext(new Request(`https://${HOST}/api/whoami`, { headers: bearer(w.scout.token) }), env);
    const ctx = { ...base, agentMcp: { token_id: "test", scopes: ["read", "write"], sealed: { ciphertext: "", iv: "" } } };
    const freshResult = await callTool(ctx, "project_create", { slug: "fresh", kind: "workspace", display_name: "Fresh" });
    expect(freshResult.isError, JSON.stringify(freshResult)).toBeUndefined();
    const fresh = freshResult.structuredContent as { channels: string[] };
    expect(fresh.channels).toEqual(["fresh-team", "fresh-ops"]);
    for (const c of fresh.channels) {
      expect((await callTool(ctx, "chat_post", { c, body: "Usable", after: 0, idempotency_key: c })).isError).toBeUndefined();
      expect((await callTool(ctx, "chat_read", { c })).isError).toBeUndefined();
    }
    const foreign = await seedTenant("foreign");
    const foreignChannel = await createChannel(env.HUB_DB, { tenant_id: foreign.id, slug: "fresh-team", display_name: "Foreign", topic: "", created_by: w.lead.identity.id }, Date.now());
    expect((await call(w.scout.token, "chat.read", { c: foreignChannel.project_id })).status).toBe(404);
    expect(await env.HUB_DB.prepare("SELECT 1 FROM conversation_member WHERE tenant_id = ?").bind(foreign.id).first()).toBeNull();
    await ok(w.scout.token, "project.create", { slug: "tracker", kind: "tracker", display_name: "Tracker" });
    expect((await call(w.scout.token, "chat.read", { c: "tracker-team" })).status).toBe(404);
    await ok(w.lead.token, "project.create", { slug: "human", kind: "workspace", display_name: "Human" });
    expect((await call(w.scout.token, "chat.read", { c: "human-team" })).status).toBe(404);
  });
  it("creates the team and ops channels with the project, skipping a taken name", async () => {
    const t = await seedTenant("acme");
    const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    await createChannel(env.HUB_DB, { tenant_id: t.id, slug: "site-ops", display_name: "taken", topic: "", created_by: pat.identity.id }, Date.now());
    const res = await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, cookieHeaders(pat.token, HOST));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { result: { channels: string[] } }).result.channels).toEqual(["site-team"]);
    const rows = await env.HUB_DB.prepare("SELECT p.slug, c.topic FROM channel c JOIN project p ON p.id = c.project_id WHERE p.tenant_id = ? ORDER BY p.slug").bind(t.id).all<{ slug: string; topic: string }>();
    expect(rows.results.map((r) => r.slug)).toEqual(["site-ops", "site-team"]);
    expect(rows.results[1]!.topic).toContain("Talk about Site");
    const docket = await (await SELF.fetch(`https://${HOST}/docket`, { headers: cookieHeaders(pat.token, HOST) })).text();
    expect(docket).not.toContain('href="/site-team/docket"');
  });
});
