// Every new project gets #<project>-team and #<project>-ops; a name already taken is skipped, never an error.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { createProject } from "../src/db/projects";
import { buildContext } from "../src/auth/context";
import { filePath, validateFile, putFile, PROJECT_FILE_BYTES, FILE_BYTES, FILE_TEXT_BYTES, BASE64_FILE_BYTES } from "../src/verbs/files";
import { redactUrl } from "../src/log";
import { PROJECT_FEATURES, projectFeatures, requireProjectFeature } from "../src/projectFeatures";
import { oauthContext } from "../src/auth/context";
import { liveGrant } from "../src/db/oauthGrants";
import { callTool } from "../src/mcp/tools";
import { registerAllVerbs } from "../src/verbs/index";
import { createChannel } from "../src/db/chat";
import { apiPost, cookieHeaders, seedGrant, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";

describe("project kinds", () => {
  it("defines all capabilities in one table", () => {
    expect(PROJECT_FEATURES).toEqual({ repo: ["docket", "repo"], tracker: ["docket"], wiki: ["wiki", "files"], workspace: ["docket", "wiki", "knowledge", "files", "people"] });
    expect(projectFeatures("channel")).toEqual([]);
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
      const tabs = html.match(/<nav class="chips" aria-label="Project features">([\s\S]*?)<\/nav>/)![1]!;
      expect(tabs).toContain("Wiki pages");
      expect(tabs).toContain("Files");
      expect(tabs).not.toContain("Repository");
      expect(tabs.includes("Docket")).toBe(kind === "workspace");
      expect(tabs.includes("Knowledge base")).toBe(kind === "workspace");
      expect(tabs.includes("People")).toBe(kind === "workspace");
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
    expect(page).toContain("Version 1");
    expect(page).toContain('enctype="multipart/form-data"');
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

describe("default project channels", () => {
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
