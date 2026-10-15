import { env, createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeGit } from "../src/code/gitAccess";
import { artifactRead } from "../src/code/artifactRead";
import { codeRead } from "../src/code/ardi";
import { artifactGit } from "../src/http/artifactGit";
import gitProxy from "../git-proxy/index";
import * as gitAccess from "../src/code/gitAccess";
import * as tenants from "../src/db/tenants";
import { repoOwnership } from "../src/code/artifactPush";
import { clearArtifactTokensForTest, type ArtifactCommit } from "../src/code/artifactsRest";
import { indexCommitNodes } from "../src/code/gitCommitIndex";
import { usesArtifacts } from "../src/code/gitBackend";
import { createGitSession } from "../src/db/sessions";
import { createProject } from "../src/db/projects";
import { packet } from "../src/code/gitProtocol";
import { seedHuman, seedTenant } from "./helpers";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { repoFile, repoSearch, searchFiles } from "../src/verbs/code";
import { buildContext } from "../src/auth/context";
import { runVerb } from "../src/verbs/dispatch";
import type { VerbDef } from "../src/verbs/table";
import { bearer, cookieHeaders, seedAgent } from "./helpers";

const hash = (n: number) => n.toString(16).padStart(40, "0");
const account = "0".repeat(32);
const metadata = (n: number, parents: number[] = []): ArtifactCommit => ({ hash: hash(n), treeHash: hash(n + 100), parents: parents.map(hash),
  author: { name: "Untrusted Author", email: "author@example.invalid" }, committer: { name: "Untrusted Committer", email: "committer@example.invalid" },
  authoredAt: 100 + n, committedAt: 200 + n, message: `Synthetic ${n}` });
function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));let offset = 0;
  for (const part of parts) { bytes.set(part, offset);offset += part.length; }return bytes;
}
afterEach(async () => { vi.restoreAllMocks();await clearArtifactTokensForTest(); });

async function setup(role: "member" | "reader" = "member") {
  const tenant = await seedTenant("acme"), human = await seedHuman("caller@example.invalid", { memberships: [{ tenant_id: tenant.id, role }] });
  const project = await createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const git = await createGitSession(env.HUB_DB, { tenant_id: tenant.id, identity_id: human.identity.id, label: "synthetic" }, Date.now());
  const configured = { ...env, GIT_BACKEND: "artifacts" as const, ARTIFACTS_ACCOUNT_ID: account, ARTIFACTS_API_TOKEN: "synthetic-control-credential" };
  const auth = `Basic ${btoa(`not-the-author:${git.token}`)}`;
  const commits = new Map([metadata(1), metadata(2, [1]), metadata(3, [1]), metadata(4, [2, 3])].map(commit => [commit.hash, commit]));
  await indexCommitNodes(env.HUB_DB, tenant.id, project.id, [...commits.values()].reverse());
  const remote = `https://${account}.artifacts.cloudflare.net/git/acme/site.git`;
  const owned = repoOwnership(tenant.id, project.id);
  let description = owned;
  const requests: string[] = [];
  let uploadPack: Uint8Array | null = null;
  let head = hash(4);
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));requests.push(url.pathname);
    if (url.pathname.endsWith("/git-upload-pack") && uploadPack) {
      expect(new Headers(init?.headers).get("git-protocol")).toBe("version=2");
      expect(await new Response(init?.body).text()).toMatch(/deepen 1\n.*want [0-9a-f]{40}\n/s);
      return new Response(uploadPack);
    }
    if (url.hostname.endsWith(".artifacts.cloudflare.net")) return new Response(concat(packet("# service=git-upload-pack\n"), new TextEncoder().encode("0000"),
      packet(`${head} HEAD\0symref=HEAD:refs/heads/main\n`), packet(`${head} refs/heads/main\n`), packet(`${hash(50)} refs/tags/v1\n`), packet(`${hash(4)} refs/tags/v1^{}\n`), new TextEncoder().encode("0000")));
    if (url.pathname.endsWith("/tokens")) return Response.json({ success: true, result: { plaintext: "opaque-synthetic-token", expires_at: new Date(Date.now() + 300_000).toISOString() } });
    if (/\/repos\/(site|site-secondary)$/.test(url.pathname)) { const name = url.pathname.split("/").at(-1)!; return Response.json({ success: true, result: { name, remote: remote.replace("site.git", `${name}.git`), description, default_branch: "main", read_only: false } }); }
    if (url.pathname.endsWith("/log")) {
      expect(url.searchParams.get("ref")).toMatch(/^[0-9a-f]{40}$/);
      return Response.json({ success: true, result: [commits.get(url.searchParams.get("ref")!)].filter(Boolean) });
    }
    if (url.pathname.includes("/commit/")) return Response.json({ success: true, result: commits.get(url.pathname.split("/").at(-1)!) });
    if (url.pathname.includes("/tree/")) {
      const sub = url.pathname.endsWith(hash(200));
      return Response.json({ success: true, result: sub
        ? [{ name: "nested.txt", hash: hash(302), type: "blob", mode: "100644" }]
        : [{ name: "README.md", hash: hash(300), type: "blob", mode: "100644" },
          { name: "src", hash: hash(200), type: "tree", mode: "40000" },
          { name: "binary", hash: hash(301), type: "blob", mode: "100644" }] });
    }
    if (url.pathname.endsWith("/file")) {
      return new Response(url.searchParams.get("path") === "binary" ? new Uint8Array([0, 1, 2])
        : url.pathname.includes("site-secondary") ? "Secondary file\n"
        : url.searchParams.get("ref") === hash(2) ? "New head\n" : "Synthetic file\n");
    }
    throw new Error("unexpected synthetic request");
  });
  return { tenant, human, project, configured, auth, fetch, requests, setDescription(value: string) { description = value; },
    setHead(value: string) { head = value; },
    serve(commit: ArtifactCommit, response: Uint8Array) { commits.set(commit.hash, commit);uploadPack = response; },
    read: <T>(verb: string, body: Record<string, unknown> = {}) => artifactRead<T>(configured, "acme", auth, verb, { repo: "site", ...body }) };
}

describe("Artifacts compatibility adapter", () => {
  it("reads a live review tip without repeated immutable fetches or ancestry traversal", async () => {
    const s = await setup();
    const first = await s.read<{ commits: Array<{ oid: string }> }>("log", { ref: "main", limit: 1 });
    expect(first.result.commits.map(c => c.oid)).toEqual([hash(4)]);
    expect(s.requests.filter(p => p.endsWith("/log"))).toHaveLength(1);
    expect(s.requests.filter(p => p.includes("/commit/"))).toHaveLength(0);
    s.requests.length = 0;
    await s.read("log", { ref: "main", limit: 1 });
    expect(s.requests.filter(p => p.endsWith("/log") || p.includes("/commit/"))).toHaveLength(0);
    expect(s.requests.filter(p => p.endsWith("/info/refs"))).toHaveLength(1);
    expect(s.requests.filter(p => p.endsWith("/repos/site"))).toHaveLength(0);
    s.setHead(hash(2));
    const moved = await s.read<{ commits: Array<{ oid: string }> }>("log", { ref: "main", limit: 1 });
    expect(moved.result.commits.map(c => c.oid)).toEqual([hash(2)]);
    s.setHead(hash(3));s.setDescription("foreign ownership");
    await expect(s.read("log", { ref: "main", limit: 1 })).rejects.toMatchObject({ status: 503 });
    s.setHead(hash(4));
    await env.HUB_DB.prepare("UPDATE membership SET state = 'revoked' WHERE tenant_id = ? AND identity_id = ?")
      .bind(s.tenant.id, s.human.identity.id).run();
    await expect(s.read("log", { ref: "main", limit: 1 })).rejects.toMatchObject({ status: 403 });
  });
  it("resolves log routing and authorization in one live repository lookup", async () => {
    const s = await setup();
    await env.HUB_DB.prepare("INSERT INTO git_repository (tenant_id, project_id, imported_at) VALUES (?, ?, 0)")
      .bind(s.tenant.id, s.project.id).run();
    const ctx = await buildContext(new Request("https://acme.pimwell.test/", {
      headers: cookieHeaders(s.human.token, "acme.pimwell.test"),
    }), s.configured);
    const prepare = vi.spyOn(ctx.db, "prepare");
    const result = await codeRead<{ commits: Array<{ oid: string }> }>(ctx, "log", { repo: "site", ref: "main", limit: 1 });
    expect(result.result.commits.map(c => c.oid)).toEqual([hash(4)]);
    const queries = prepare.mock.calls.map(([sql]) => sql);
    expect(queries.filter(sql => sql.includes("repositoryQuery"))).toHaveLength(1);
    expect(queries.some(sql => sql.includes("usesArtifacts") || sql.includes("ardi_cred"))).toBe(false);
  });

  it("starts live authorization beside routing and consumes it only once", async () => {
    const s = await setup(), grant = await authorizeGit(s.configured, s.auth, "acme", "site");
    await env.HUB_DB.prepare("INSERT OR IGNORE INTO git_repository (tenant_id,project_id,imported_at) VALUES (?,?,0)").bind(s.tenant.id, s.project.id).run();
    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });
    const authorize = vi.spyOn(gitAccess, "authorizeGit").mockImplementation(async () => { release(); return grant; });
    vi.spyOn(tenants, "getTenantBySlug").mockImplementation(async () => { await started;return s.tenant; });
    const configured = { ...s.configured, HUB: { fetch: async () => new Response("unexpected hub") } } as any;
    const response = await gitProxy.fetch(new Request("https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack", { headers: { authorization: s.auth } }), configured, createExecutionContext());
    expect(response.status).toBe(200);expect(await response.text()).toContain(`${hash(4)} HEAD`);
    expect(authorize).toHaveBeenCalledTimes(1);expect(authorize.mock.calls[0]![1]).toBe(s.auth);
  });
  it("fails closed for mis-scoped preauthorization and preserves lookup errors as 503", async () => {
    const s = await setup(), grant = (await authorizeGit(s.configured, s.auth, "acme", "site"))!;
    const request = () => new Request("https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack", { headers: { authorization: s.auth } });
    for (const wrong of [
      { ...grant, tenant: { ...grant.tenant, slug: "foreign" } },
      { ...grant, project: { ...grant.project, slug: "other" } },
      { ...grant, repository: { name: "secondary", storage_name: "other", is_default: 0 } },
    ]) expect((await artifactGit(request(), s.configured, "acme", Promise.resolve(wrong))).status).toBe(404);
    expect(s.requests).toHaveLength(0);
    expect((await artifactGit(request(), s.configured, "acme", Promise.reject(new Error("lookup failed")))).status).toBe(503);
    expect(s.requests).toHaveLength(0);
  });
  it("reuses the live ownership metadata for HEAD normalization without log lookups", async () => {
    const s = await setup(), batch = vi.spyOn(s.configured.HUB_DB, "batch");
    const response = await artifactGit(new Request("https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack", { headers: { authorization: s.auth } }), s.configured, "acme");
    expect(response.status).toBe(200);expect(await response.text()).toContain(`${hash(4)} HEAD`);
    expect(batch).toHaveBeenCalledTimes(1);expect(batch.mock.calls[0]![0]).toHaveLength(8);
    expect(s.requests.filter(path => path.endsWith("/repos/site"))).toHaveLength(1);
    expect(s.requests.filter(path => path.endsWith("/log"))).toHaveLength(0);
    await clearArtifactTokensForTest(true);
    s.setDescription("foreign ownership");s.requests.length = 0;
    const denied = await artifactGit(new Request("https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack", { headers: { authorization: s.auth } }), s.configured, "acme");
    expect(denied.status).toBe(503);
    expect(s.requests.some(path => path.includes("/git/"))).toBe(false);
    const caller = await authorizeGit(s.configured, s.auth, "acme", "site");
    await env.HUB_DB.prepare("UPDATE session SET revoked_at=1 WHERE id=?").bind(caller!.session.id).run();
    s.requests.length = 0;
    const revoked = await artifactGit(new Request("https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack", { headers: { authorization: s.auth } }), s.configured, "acme");
    expect(revoked.status).toBe(401);expect(s.requests).toHaveLength(0);
  });
  it("routes named repositories with isolated history and attribution while preserving the default", async () => {
    const s = await setup();
    await env.HUB_DB.prepare("INSERT INTO git_repository (tenant_id, project_id, imported_at) VALUES (?, ?, ?)").bind(s.tenant.id, s.project.id, Date.now()).run();
    await env.HUB_DB.prepare("INSERT INTO repository (tenant_id, project_id, name, storage_name, is_default, created_at) VALUES (?, ?, 'secondary', 'site-secondary', 0, ?)").bind(s.tenant.id, s.project.id, Date.now()).run();
    await indexCommitNodes(env.HUB_DB, s.tenant.id, s.project.id, [{...metadata(4), parents: []}], "secondary");
    await env.HUB_DB.prepare("INSERT INTO code_event (tenant_id, project_id, repo, ardi_id, kind, identity_id, target, at) VALUES (?, ?, '', 1, 'commit', ?, ?, ?)").bind(s.tenant.id, s.project.id, s.human.identity.id, hash(4), Date.now()).run();
    const named = await s.read<{commits: Array<{oid: string; principal: string|null}>}>("log", {repo: "site/secondary"});
    expect(named.result.commits.map(c => c.oid)).toEqual([hash(4)]);
    expect(named.result.commits[0]!.principal).toBeNull();
    const original = await s.read<{commits: Array<{oid: string; principal: string|null}>}>("log");
    expect(original.result.commits.map(c => c.oid)).toEqual([hash(4), hash(3), hash(2), hash(1)]);
    expect(original.result.commits[0]!.principal).toBe(s.human.identity.id);
    const request = (name: string) => new Request(`https://acme.pimwell.test/site/${name}.git/info/refs?service=git-upload-pack`, {headers: {authorization: s.auth}});
    expect((await artifactGit(request("secondary"), s.configured, "acme")).status).toBe(200);
    expect(s.requests.some(p => p.includes("site-secondary.git"))).toBe(true);
    expect(await authorizeGit(s.configured, s.auth, "acme", "site/missing")).toBeNull();
    expect(await authorizeGit(s.configured, s.auth, "foreign", "site/secondary")).toBeNull();
    await env.HUB_DB.prepare("UPDATE membership SET role = 'reader' WHERE identity_id = ?").bind(s.human.identity.id).run();
    expect((await authorizeGit(s.configured, s.auth, "acme", "site/secondary"))?.write).toBe(false);
    const push = new Request("https://acme.pimwell.test/site/secondary.git/info/refs?service=git-receive-pack", {headers:{authorization:s.auth}});
    expect((await artifactGit(push, s.configured, "acme")).status).toBe(403);
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ?").bind(s.human.identity.id).run();
    expect(await authorizeGit(s.configured, s.auth, "acme", "site/secondary")).toBeNull();
  });
  it("includes merged branch commits in all-parent history, with the old OID cursor format", async () => {
    const s = await setup();
    const first = await s.read<{ commits: Array<{ oid: string }> }>("log", { ref: "HEAD", limit: 2 });
    expect(first.result.commits.map(commit => commit.oid)).toEqual([hash(4), hash(3)]);
    expect(first.next).toBe(hash(3));
    const next = await s.read<{ commits: Array<{ oid: string }> }>("log", { ref: "HEAD", limit: 2, since: first.next });
    expect(next.result.commits.map(commit => commit.oid)).toEqual([hash(2), hash(1)]);expect(next.next).toBeNull();
  });
  it.each(["HEAD", "refs/heads/main", "refs/tags/v1"])("resolves %s to an immutable commit before reading files", async revision => {
    const s = await setup();expect((await s.read<{ content_b64: string; size: number }>("file.show", { rev: revision, path: "README.md" })).result).toEqual({ content_b64: btoa("Synthetic file\n"), size: 15 });
  });
  it("combines directory detection and retrieval, caching immutable reads behind fresh grants", async () => {
    const s = await setup();
    const file = await s.read("file.read", { rev: hash(4), path: "README.md" });
    expect(file.result).toEqual({ content_b64: btoa("Synthetic file\n"), size: 15 });
    expect(s.requests.filter(p => p.endsWith("/log") || p.endsWith("/info/refs"))).toHaveLength(0);
    expect(s.requests.filter(p => p.includes("/tree/"))).toHaveLength(1);
    const dir = await s.read<{ entries: unknown[] }>("file.read", { rev: hash(4), path: "src" });
    expect(dir.result.entries).toEqual([{ name: "nested.txt", oid: hash(302), mode: "100644", kind: "blob" }]);
    const nested = await s.read("file.read", { rev: hash(4), path: "src/nested.txt" });
    expect(nested.result).toEqual(file.result);
    const count = s.requests.length;
    for (let i = 0; i < 100; i++) expect(await s.read("file.read", { rev: hash(4), path: i % 2 ? "src" : "README.md" })).toEqual(i % 2 ? dir : file);
    expect(s.requests).toHaveLength(count);
    await expect(s.read("file.read", { rev: hash(4), path: "src/../README.md" })).rejects.toMatchObject({ status: 400 });
    await expect(s.read("file.read", { rev: hash(4), path: "missing" })).rejects.toMatchObject({ status: 404 });
    const before = s.requests.length;
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ?").bind(s.human.identity.id).run();
    await expect(s.read("file.read", { rev: hash(4), path: "README.md" })).rejects.toMatchObject({ status: 403 });
    expect(s.requests).toHaveLength(before);
  });
  it("never caches branch or HEAD resolution and scopes equal SHAs to their repository and tenant", async () => {
    const s = await setup();
    const old = await s.read("file.read", { rev: "HEAD", path: "README.md" });
    s.setHead(hash(2));
    const fresh = await s.read("file.read", { rev: "HEAD", path: "README.md" });
    expect(fresh.result).toEqual({ content_b64: btoa("New head\n"), size: 9 });
    expect(fresh.result).not.toEqual(old.result);
    await env.HUB_DB.prepare("INSERT INTO repository (tenant_id, project_id, name, storage_name, is_default, created_at) VALUES (?, ?, 'secondary', 'site-secondary', 0, ?)").bind(s.tenant.id, s.project.id, Date.now()).run();
    const named = await s.read("file.read", { repo: "site/secondary", rev: hash(4), path: "README.md" });
    expect(named.result).toEqual({ content_b64: btoa("Secondary file\n"), size: 15 });
    await seedTenant("foreign");
    const count = s.requests.length;
    await expect(artifactRead(s.configured, "foreign", s.auth, "file.read", { repo: "site", rev: hash(4), path: "README.md" })).rejects.toMatchObject({ status: 403 });
    await env.HUB_DB.prepare("UPDATE session SET revoked_at = ? WHERE id = ?").bind(Date.now(), (await authorizeGit(s.configured, s.auth, "acme", "site"))!.session.id).run();
    await expect(s.read("file.read", { rev: hash(4), path: "README.md" })).rejects.toMatchObject({ status: 403 });
    expect(s.requests).toHaveLength(count);
  });
  it("shares the hub's live caller for repo_file without minting another credential; operator revocation denies warm hits", async () => {
    const s = await setup();
    await env.HUB_DB.prepare("INSERT INTO git_repository (tenant_id, project_id, imported_at) VALUES (?, ?, ?)").bind(s.tenant.id, s.project.id, Date.now()).run();
    const bot = await seedAgent(s.tenant, s.human.identity, "reader", "reader");
    const call = async (headers: Record<string, string>, path = "README.md") => {
      const ctx = await buildContext(new Request("https://acme.pimwell.test/", { headers }), s.configured);
      return runVerb(ctx, repoFile as VerbDef<unknown, unknown>, { project: "site", ref: hash(4), path });
    };
    expect(await call(cookieHeaders(s.human.token, "acme.pimwell.test"))).toMatchObject({ text: "Synthetic file\n", binary: false });
    expect(await env.HUB_DB.prepare("SELECT 1 FROM ardi_cred").first()).toBeNull();
    expect(await call(bearer(bot.token))).toMatchObject({ text: "Synthetic file\n", binary: false });
    expect(await call(bearer(bot.token), "binary")).toMatchObject({ binary: true, size: 3 });
    const count = s.requests.length;
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ?").bind(s.human.identity.id).run();
    await expect(call(bearer(bot.token))).rejects.toMatchObject({ status: 404 });
    await expect(call(cookieHeaders(s.human.token, "acme.pimwell.test"))).rejects.toMatchObject({ status: 404 });
    expect(s.requests).toHaveLength(count);
  });
  it("keeps raw annotated tag targets in refs, without showing peeled pseudo-refs", async () => {
    const s = await setup();const result = await s.read<{ refs: Array<{ name: string; target: string }> }>("refs.list");
    expect(result.result.refs).toEqual([{ name: "refs/heads/main", target: hash(4) }, { name: "refs/tags/v1", target: hash(50) }]);
  });
  it("does not promote the commit author to the authenticated pusher", async () => {
    const s = await setup();let result = await s.read<{ commits: Array<{ principal: string | null }> }>("log", { ref: "HEAD", limit: 1 });
    expect(result.result.commits[0]!.principal).toBeNull();
    await env.HUB_DB.prepare("INSERT INTO code_event (tenant_id, project_id, ardi_id, kind, identity_id, target, at) VALUES (?, ?, 1, 'commit', ?, ?, ?)")
      .bind(s.tenant.id, s.project.id, s.human.identity.id, hash(4), Date.now()).run();
    result = await s.read("log", { ref: "HEAD", limit: 1 });expect(result.result.commits[0]!.principal).toBe(s.human.identity.id);
  });
  it("refuses a reused storage name belonging to another tenant/project", async () => {
    const s = await setup();s.setDescription("another owner");await expect(s.read("refs.list")).rejects.toThrow("not ready");
    expect(s.requests.some(path => path.startsWith("/git/"))).toBe(false);
  });
  it("selects only completed imports; other existing repositories stay on the legacy host", async () => {
    const s = await setup();expect(await usesArtifacts(s.configured, "acme", "site")).toBe(false);
    await env.HUB_DB.prepare("INSERT INTO git_repository (tenant_id, project_id, imported_at) VALUES (?, ?, ?)").bind(s.tenant.id, s.project.id, Date.now()).run();
    expect(await usesArtifacts(s.configured, "acme", "site")).toBe(true);expect(await usesArtifacts(s.configured, "other", "site")).toBe(false);
  });
  it("rejects anonymous and read-only pushes before contacting Artifacts", async () => {
    const s = await setup("reader");
    for (const authorization of [null, s.auth]) {
      const headers = new Headers();if (authorization) headers.set("authorization", authorization);
      const response = await artifactGit(new Request("https://acme.pimwell.test/site.git/info/refs?service=git-receive-pack", { headers }), s.configured, "acme");
      expect(response.status).toBe(authorization ? 403 : 401);
    }
    expect(s.fetch).not.toHaveBeenCalled();
  });
});

// A minimal pack: whole objects, plus one REF_DELTA and one OFS_DELTA against the first blob.
function syntheticSnapshot() {
  const enc = new TextEncoder(), sha = (type: string, data: Uint8Array) => createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");
  const raw = (hex: string) => Uint8Array.from(hex.match(/../g)!, (b) => Number.parseInt(b, 16));
  const header = (type: number, size: number) => {
    const out = [(type << 4) | (size & 15)];size >>= 4;
    while (size) { out[out.length - 1]! |= 0x80;out.push(size & 0x7f);size >>= 7; }return Uint8Array.from(out);
  };
  const base = enc.encode("export const alpha = 1;\n// TODO find the Needle\n");
  const extra = enc.encode("needle again\n"), derived = concat(base, extra);
  const delta = concat(Uint8Array.from([base.length, derived.length, 0x90, base.length, extra.length]), extra);
  const binary = Uint8Array.from([0x89, 0x50, 0, 1, 2, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]);
  const entry = (mode: string, name: string, oid: string) => concat(enc.encode(`${mode} ${name}\0`), raw(oid));
  const sub = concat(entry("100644", "b.ts", sha("blob", derived)), entry("100644", "c.ts", sha("blob", derived)));
  const root = concat(entry("100644", "a.ts", sha("blob", base)), entry("100644", "logo.png", sha("blob", binary)), entry("40000", "src", sha("tree", sub)));
  const commitBody = enc.encode(`tree ${sha("tree", root)}\nauthor A <a@example.invalid> 1 +0000\ncommitter A <a@example.invalid> 1 +0000\n\nSynthetic\n`);
  const objects: Uint8Array[] = [];
  const whole = (type: number, data: Uint8Array) => objects.push(concat(header(type, data.length), deflateSync(data)));
  whole(3, base);
  objects.push(concat(header(7, delta.length), raw(sha("blob", base)), deflateSync(delta)));
  const ofsStart = 12 + objects[0]!.length + objects[1]!.length;
  objects.push(concat(header(6, delta.length), Uint8Array.from([ofsStart - 12]), deflateSync(delta)));
  whole(3, binary);whole(2, sub);whole(2, root);whole(1, commitBody);
  const head = new Uint8Array(12);head.set(enc.encode("PACK"));new DataView(head.buffer).setUint32(4, 2);new DataView(head.buffer).setUint32(8, objects.length);
  const pack = concat(head, ...objects);
  const band = (bytes: Uint8Array) => { const out = new Uint8Array(bytes.length + 5);out.set(enc.encode((bytes.length + 5).toString(16).padStart(4, "0")));out[4] = 1;out.set(bytes, 5);return out; };
  const response = concat(band(enc.encode("packfile\n")), band(pack), enc.encode("0000"));
  const oid = sha("commit", commitBody);
  return { response, commit: { ...metadata(9), hash: oid, treeHash: sha("tree", root) } };
}

describe("Artifacts code snapshots", () => {
  it("reads a commit's files from one shallow fetch, resolving deltas, then serves repeats from the cache", async () => {
    const s = await setup(), { response, commit } = syntheticSnapshot();
    s.serve(commit, response);
    const first = await s.read<{ oid: string; files: Array<{ path: string; text: string | null; binary: boolean }> }>("snapshot", { rev: commit.hash });
    expect(first.result.oid).toBe(commit.hash);
    expect(first.result.files.map((f) => [f.path, f.binary])).toEqual([["a.ts", false], ["logo.png", true], ["src/b.ts", false], ["src/c.ts", false]]);
    expect(first.result.files[2]!.text).toBe(first.result.files[3]!.text);
    expect(first.result.files[2]!.text).toContain("needle again");
    s.requests.length = 0;
    const again = await s.read<{ files: unknown[] }>("snapshot", { rev: commit.hash });
    expect(again.result.files).toEqual(first.result.files);
    expect(s.requests).toEqual([]);
    expect(s.requests.filter((path) => path.endsWith("/git-upload-pack"))).toHaveLength(0);
  });

  it("resolves symbolic refs freshly without a commit log, and shares their verified snapshot with immutable reads", async () => {
    const s = await setup(), { response, commit } = syntheticSnapshot();
    s.serve(commit, response);s.setHead(commit.hash);
    const first = await s.read("snapshot", { rev: "main" });
    expect(s.requests.some(path => path.endsWith("/log"))).toBe(false);
    s.requests.length = 0;
    expect(await s.read("snapshot", { rev: "HEAD" })).toEqual(first);
    expect(s.requests.some(path => path.endsWith("/info/refs"))).toBe(true);
    expect(s.requests.some(path => path.endsWith("/git-upload-pack"))).toBe(false);
    s.setHead(hash(999));
    await expect(s.read("snapshot", { rev: "main" })).rejects.toMatchObject({ status: 502 });
    s.setDescription("another owner");
    await expect(s.read("snapshot", { rev: "main" })).rejects.toMatchObject({ status: 503 });
  });

  it("shares fresh hub authorization for search, denying warm snapshots after operator revocation", async () => {
    const s = await setup(), { response, commit } = syntheticSnapshot();
    s.serve(commit, response);
    await env.HUB_DB.prepare("INSERT INTO git_repository (tenant_id, project_id, imported_at) VALUES (?, ?, ?)").bind(s.tenant.id, s.project.id, Date.now()).run();
    const bot = await seedAgent(s.tenant, s.human.identity, "reader", "reader");
    const call = async (headers: Record<string, string>) => {
      const ctx = await buildContext(new Request("https://acme.pimwell.test/", { headers }), s.configured);
      return runVerb(ctx, repoSearch as VerbDef<unknown, unknown>, { project: "site", ref: commit.hash, q: "needle" });
    };
    const first = await call(cookieHeaders(s.human.token, "acme.pimwell.test"));
    expect(first).toMatchObject({ searched: 3, skipped_binary: 1 });
    expect(await call(bearer(bot.token))).toEqual(first);
    expect(await env.HUB_DB.prepare("SELECT 1 FROM ardi_cred").first()).toBeNull();
    const count = s.requests.length;
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ?").bind(s.human.identity.id).run();
    await expect(call(bearer(bot.token))).rejects.toMatchObject({ status: 404 });
    await expect(call(cookieHeaders(s.human.token, "acme.pimwell.test"))).rejects.toMatchObject({ status: 404 });
    expect(s.requests).toHaveLength(count);
  });

  it("checks the caller's access before answering from the cache", async () => {
    const s = await setup(), { response, commit } = syntheticSnapshot();
    s.serve(commit, response);
    await s.read("snapshot", { rev: commit.hash });
    await expect(artifactRead(s.configured, "acme", "Basic " + btoa("x:not-a-session"), "snapshot", { repo: "site", rev: commit.hash })).rejects.toMatchObject({ status: 403 });
  });

  it("searches literally and case-insensitively by default, or by regex, under a path, within a limit", () => {
    const files = [
      { path: "src/b.ts", text: "const Needle = 1;\nnothing\nneedle()\n", size: 0, binary: false },
      { path: "a.ts", text: "a needle.*\n", size: 0, binary: false },
      { path: "logo.png", text: null, size: 9, binary: true },
      { path: "big.json", text: null, size: 500_000, binary: false },
    ];
    const all = searchFiles(files, "needle", { regex: false, caseSensitive: false, path: "", limit: 50 });
    expect(all.matches).toEqual([{ path: "a.ts", line: 1, text: "a needle.*" }, { path: "src/b.ts", line: 1, text: "const Needle = 1;" }, { path: "src/b.ts", line: 3, text: "needle()" }]);
    expect(all).toMatchObject({ searched: 2, skipped_binary: 1, skipped_large: 1, truncated: false });
    expect(searchFiles(files, "needle.*", { regex: false, caseSensitive: false, path: "", limit: 50 }).matches).toHaveLength(1);
    expect(searchFiles(files, "Needle", { regex: false, caseSensitive: true, path: "", limit: 50 }).matches).toHaveLength(1);
    expect(searchFiles(files, "^needle\\(", { regex: true, caseSensitive: false, path: "", limit: 50 }).matches).toEqual([{ path: "src/b.ts", line: 3, text: "needle()" }]);
    expect(searchFiles(files, "needle", { regex: false, caseSensitive: false, path: "src/", limit: 50 }).matches).toHaveLength(2);
    expect(searchFiles(files, "needle", { regex: false, caseSensitive: false, path: "", limit: 2 })).toMatchObject({ truncated: true, matches: [{}, {}] });
    expect(() => searchFiles(files, "(", { regex: true, caseSensitive: false, path: "", limit: 50 })).toThrow(/regular expression/);
  });
});
