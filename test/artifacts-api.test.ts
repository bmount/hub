import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactRead } from "../src/code/artifactRead";
import { artifactGit } from "../src/http/artifactGit";
import { repoOwnership } from "../src/code/artifactPush";
import { clearArtifactTokensForTest, type ArtifactCommit } from "../src/code/artifactsRest";
import { indexCommitNodes } from "../src/code/gitCommitIndex";
import { usesArtifacts } from "../src/code/gitBackend";
import { createGitSession } from "../src/db/sessions";
import { createProject } from "../src/db/projects";
import { packet } from "../src/code/gitProtocol";
import { seedHuman, seedTenant } from "./helpers";

const hash = (n: number) => n.toString(16).padStart(40, "0");
const account = "0".repeat(32);
const metadata = (n: number, parents: number[] = []): ArtifactCommit => ({ hash: hash(n), treeHash: hash(n + 100), parents: parents.map(hash),
  author: { name: "Untrusted Author", email: "author@example.invalid" }, committer: { name: "Untrusted Committer", email: "committer@example.invalid" },
  authoredAt: 100 + n, committedAt: 200 + n, message: `Synthetic ${n}` });
function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));let offset = 0;
  for (const part of parts) { bytes.set(part, offset);offset += part.length; }return bytes;
}
afterEach(() => { vi.restoreAllMocks();clearArtifactTokensForTest(); });

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
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));requests.push(url.pathname);
    if (url.hostname.endsWith(".artifacts.cloudflare.net")) return new Response(concat(packet("# service=git-upload-pack\n"), new TextEncoder().encode("0000"),
      packet(`${hash(4)} HEAD\0symref=HEAD:refs/heads/main\n`), packet(`${hash(4)} refs/heads/main\n`), packet(`${hash(50)} refs/tags/v1\n`), packet(`${hash(4)} refs/tags/v1^{}\n`), new TextEncoder().encode("0000")));
    if (url.pathname.endsWith("/tokens")) return Response.json({ success: true, result: { plaintext: "opaque-synthetic-token", expires_at: new Date(Date.now() + 300_000).toISOString() } });
    if (url.pathname.endsWith("/repos/site")) return Response.json({ success: true, result: { name: "site", remote, description, default_branch: "main", read_only: false } });
    if (url.pathname.endsWith("/log")) {
      expect(url.searchParams.get("ref")).toMatch(/^[0-9a-f]{40}$/);
      return Response.json({ success: true, result: [commits.get(url.searchParams.get("ref")!)].filter(Boolean) });
    }
    if (url.pathname.includes("/commit/")) return Response.json({ success: true, result: commits.get(url.pathname.split("/").at(-1)!) });
    if (url.pathname.endsWith("/file")) {
      expect(url.searchParams.get("ref")).toBe(hash(4));return new Response("Synthetic file\n");
    }
    throw new Error("unexpected synthetic request");
  });
  return { tenant, human, project, configured, auth, fetch, requests, setDescription(value: string) { description = value; },
    read: <T>(verb: string, body: Record<string, unknown> = {}) => artifactRead<T>(configured, "acme", auth, verb, { repo: "site", ...body }) };
}

describe("Artifacts compatibility adapter", () => {
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
