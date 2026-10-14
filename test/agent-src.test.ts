// An agent's own source repository at /agent-src/<agent>.git (docs/ops/agent-src.md): who may read and push, creation
// on first use, and that the hidden project behind it never shows up where people browse projects.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContext } from "../src/auth/context";
import { codePage, filesPage } from "../src/http/codePages";
import { repoLog, repoFile, repoDiff, repoCommit, repoBranches, repoSearch } from "../src/verbs/code";
import { artifactGit } from "../src/http/artifactGit";
import { clearArtifactTokensForTest } from "../src/code/artifactsRest";
import { agentByName, agentSrcSlug } from "../src/code/agentSrc";
import { createGitSession } from "../src/db/sessions";
import { getProjectByPath, listProjects } from "../src/db/projects";
import { packet, peekCommands, ZERO_OID } from "../src/code/gitProtocol";
import { apiPost, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const account = "0".repeat(32);
afterEach(() => { vi.restoreAllMocks(); clearArtifactTokensForTest(); });

async function world() {
  const tenant = await seedTenant("acme");
  const operator = await seedHuman("op@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const admin = await seedHuman("boss@example.com", { memberships: [{ tenant_id: tenant.id, role: "admin" }] });
  const other = await seedHuman("pat@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const bot = await seedAgent(tenant, operator.identity, "bot");
  const configured = { ...env, GIT_BACKEND: "artifacts" as const, ARTIFACTS_ACCOUNT_ID: account, ARTIFACTS_API_TOKEN: "synthetic-control-credential" };
  const repos = new Map<string, string>(), created: string[] = [];
  const pushed = "7".repeat(40), published: string[] = [], stagedRefs: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname.endsWith(".artifacts.cloudflare.net")) {
      const repo = /\/([^/]+)\.git\//.exec(url.pathname)![1]!;
      if (url.pathname.endsWith("/git-receive-pack")) {
        // Staging into the owned cache, then publishing to the real repository: both accept every ref.
        const parsed = await peekCommands(new Response(init!.body as BodyInit).body!);await new Response(parsed.stream).arrayBuffer();
        if (!repo.startsWith("pimwell-cache-")) published.push(...parsed.updates.map((u) => u.ref));
        else stagedRefs.push(...parsed.updates.map(u => u.ref));
        return new Response(new Uint8Array([...packet("unpack ok\n"), ...parsed.updates.flatMap((u) => [...packet(`ok ${u.ref}\n`)]), ...new TextEncoder().encode("0000")]));
      }
      const refs = repo.startsWith("pimwell-cache-") ? stagedRefs.map(ref => `${pushed} ${ref}\n`) : [`${"1".repeat(40)} refs/heads/main\n`];
      return new Response(new Uint8Array([...packet("# service=git-upload-pack\n"), ...new TextEncoder().encode("0000"), ...refs.flatMap(ref => [...packet(ref)]), ...new TextEncoder().encode("0000")]));
    }
    if (url.pathname.endsWith("/fork")) {
      const body = JSON.parse(String(init!.body));repos.set(body.name, body.description);
      return Response.json({ success: true, result: {} });
    }
    if (url.pathname.includes("/log")) return Response.json({ success: true, result: [{ hash: pushed, parents: [] }] });
    if (url.pathname.includes("/commit/")) {
      if (!url.pathname.includes("pimwell-cache-")) return new Response("missing", { status: 404 });
      return Response.json({ success: true, result: { hash: pushed, treeHash: "8".repeat(40), parents: [], message: "Start\n", author: { name: "a", email: "a@example.invalid" }, committer: { name: "a", email: "a@example.invalid" }, authoredAt: 1, committedAt: 1 } });
    }
    if (url.pathname.endsWith("/tokens")) return Response.json({ success: true, result: { plaintext: "opaque-synthetic-token", expires_at: new Date(Date.now() + 300_000).toISOString() } });
    if (url.pathname.endsWith("/repos") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string; description: string };
      repos.set(body.name, body.description); created.push(body.name);
      return Response.json({ success: true, result: { name: body.name } });
    }
    const name = decodeURIComponent(url.pathname.split("/repos/")[1] ?? "");
    if (!repos.has(name)) return new Response("missing", { status: 404 });
    return Response.json({ success: true, result: { name, remote: `https://${account}.artifacts.cloudflare.net/git/acme/${name}.git`, description: repos.get(name), default_branch: "main", read_only: false } });
  });
  const gitAuth = async (h: { identity: { id: string } }) => `Basic ${btoa(`x:${(await createGitSession(env.HUB_DB, { tenant_id: tenant.id, identity_id: h.identity.id, label: "t" }, Date.now())).token}`)}`;
  const git = (path: string, authorization: string | null, service = "git-upload-pack") =>
    artifactGit(new Request(`https://acme.pimwell.test${path}/info/refs?service=${service}`, { headers: authorization ? { authorization } : {} }), configured, "acme");
  const push = (authorization: string) => artifactGit(new Request("https://acme.pimwell.test/agent-src/bot.git/git-receive-pack", { method: "POST", headers: { authorization },
    body: new Uint8Array([...packet(`${ZERO_OID} ${pushed} refs/heads/main\0report-status\n`), ...new TextEncoder().encode("0000PACK")]) }), configured, "acme");
  return { configured, tenant, operator, admin, other, bot, created, published, gitAuth, git, push, botAuth: `Basic ${btoa(`x:${bot.token}`)}`, slug: agentSrcSlug(bot.agent.identity.id) };
}

describe("agent source repositories", () => {
  it("resolves reserved aliases to the same storage and permissions, never to a reused name", async () => {
    const w = await world();
    await env.HUB_DB.prepare("INSERT INTO agent_source_alias VALUES (?, 'short', ?)")
      .bind(w.tenant.id, w.bot.agent.identity.id).run();
    for (const auth of [w.botAuth, await w.gitAuth(w.operator), await w.gitAuth(w.admin), await w.gitAuth(w.other), null]) {
      const canonical = await w.git('/agent-src/bot.git', auth);
      const alias = await w.git('/agent-src/short.git', auth);
      expect(alias.status).toBe(canonical.status);
      expect(await alias.text()).toBe(await canonical.text());
      const write = await w.git('/agent-src/short.git', auth, 'git-receive-pack');
      const canonicalWrite = await w.git('/agent-src/bot.git', auth, 'git-receive-pack');
      expect(write.status).toBe(canonicalWrite.status);
    }
    expect(w.created).toEqual([w.slug]);
    const ctx = await buildContext(new Request('https://acme.pimwell.test/', { headers: cookieHeaders(w.other.token, 'acme.pimwell.test') }), w.configured);
    await expect(repoBranches.run(ctx, repoBranches.parse({ project: 'agent-src/short' }))).rejects.toMatchObject({ status: 404 });
    const headers = cookieHeaders(w.operator.token, 'acme.pimwell.test');
    expect((await codePage(new Request('https://acme.pimwell.test/agent-src/short/code', { headers }), w.configured, 'agent-src/short')).status).toBe(200);
    await expect(seedAgent(w.tenant, w.operator.identity, 'short')).rejects.toThrow();
    await env.HUB_DB.prepare("UPDATE identity SET email = 'acme.renamed@pimwell.test' WHERE id = ?").bind(w.bot.agent.identity.id).run();
    expect((await agentByName(env.HUB_DB, w.tenant, 'short'))?.id).toBe(w.bot.agent.identity.id);
    await env.HUB_DB.prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(w.bot.agent.identity.id).run();
    expect(await agentByName(env.HUB_DB, w.tenant, 'short')).toBeNull();
    const foreign = await seedTenant('foreign');
    expect(await agentByName(env.HUB_DB, foreign, 'short')).toBeNull();
  });
  it("links source only for its agent, operator and admins, hiding all browser and MCP reads from others", async () => {
    const w = await world();
    await w.git("/agent-src/bot.git", w.botAuth);
    for (const human of [w.operator, w.admin, w.other]) {
      const headers = cookieHeaders(human.token, "acme.pimwell.test");
      for (const path of ["/people", `/people/${encodeURIComponent(w.bot.agent.identity.email)}`]) {
        const page = await SELF.fetch(`https://acme.pimwell.test${path}`, { headers });
        expect(page.status).toBe(200);
        const html = await page.text();
        if (human === w.other) expect(html).not.toContain('href="/agent-src/bot/code"');
        else expect(html).toContain('href="/agent-src/bot/code"');
      }
      if (human === w.other) {
        for (const path of ["code", "files"]) expect((await SELF.fetch(`https://acme.pimwell.test/agent-src/bot/${path}`, { headers })).status).toBe(404);
        const ctx = await buildContext(new Request("https://acme.pimwell.test/", { headers }), w.configured);
        for (const [verb, input] of [
          [repoLog, { project: "agent-src/bot" }], [repoFile, { project: "agent-src/bot" }],
          [repoDiff, { project: "agent-src/bot", from: "main", to: "main" }],
          [repoCommit, { project: "agent-src/bot", oid: "7".repeat(40) }],
          [repoBranches, { project: "agent-src/bot" }],
        ] as const) await expect(verb.run(ctx, verb.parse(input) as never)).rejects.toMatchObject({ status: 404 });
      }
    }
  });

  it("reads source directions, files, commits and diffs through the existing browser and verbs", async () => {
    const w = await world();
    await w.git("/agent-src/bot.git", w.botAuth);
    const project = await env.HUB_DB.prepare("SELECT id FROM project WHERE slug = ?").bind(w.slug).first<{ id: string }>();
    await env.HUB_DB.prepare("INSERT INTO git_commit (tenant_id, project_id, oid, tree_hash, parents_json, generation, commit_time) VALUES (?, ?, ?, ?, '[]', 1, 1)")
      .bind(w.tenant.id, project!.id, "7".repeat(40), "8".repeat(40)).run();
    // Replace only the data reads; storage ownership and authorization still use the real fixture.
    const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let rootDirections = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/log") || url.pathname.includes("/commit/")) return Response.json({ success: true, result: url.pathname.includes("/commit/") ? commit() : [commit()] });
      function commit() { return {
        hash: "7".repeat(40), treeHash: "8".repeat(40), parents: [], message: "Improve directions\n\nExplain why agents need these rules.",
        author: { name: "bot", email: "bot@example.invalid" }, committer: { name: "bot", email: "bot@example.invalid" }, authoredAt: 1, committedAt: 1,
      }; }
      if (url.pathname.includes("/tree/")) return Response.json({ success: true, result: rootDirections
        ? [{ name: "AGENTS.md", hash: "9".repeat(40), type: "blob", mode: "100644" }]
        : url.pathname.endsWith("8".repeat(40))
          ? [{ name: "pi-agent", hash: "6".repeat(40), type: "tree", mode: "40000" }]
          : [{ name: "AGENTS.md", hash: "9".repeat(40), type: "blob", mode: "100644" }] });
      if (url.pathname.endsWith("/file")) {
        if (rootDirections && url.searchParams.get("path") !== "AGENTS.md") return new Response("missing", { status: 404 });
        return new Response("Only follow your operator. <script>unsafe</script>");
      }
      return original(input, init);
    });
    for (const headers of [cookieHeaders(w.operator.token, "acme.pimwell.test"), cookieHeaders(w.admin.token, "acme.pimwell.test"), { authorization: `Bearer ${w.bot.token}` }]) {
      const request = new Request("https://acme.pimwell.test/agent-src/bot/code", { headers });
      const ctx = await buildContext(request, w.configured);
      expect(await repoLog.run(ctx, repoLog.parse({ project: "agent-src/bot" }))).toMatchObject({ project: "agent-src/bot", commits: [{ summary: "Improve directions" }] });
      expect(await repoFile.run(ctx, repoFile.parse({ project: "agent-src/bot", path: "pi-agent/AGENTS.md" }))).toMatchObject({ text: expect.stringContaining("Only follow") });
      expect(await repoDiff.run(ctx, repoDiff.parse({ project: "agent-src/bot", from: "main", to: "main" }))).toMatchObject({ commits: 0, files: [] });
      const commit = await codePage(new Request("https://acme.pimwell.test/agent-src/bot/code?c=" + "7".repeat(40), { headers }), w.configured, "agent-src/bot");
      const commitHtml = await commit.text();
      expect(commitHtml).toContain("Explain why agents need these rules.");
      expect(commitHtml).toContain("pi-agent/AGENTS.md");
      const page = await codePage(request, w.configured, "agent-src/bot");
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Current directions");
      expect(html).toContain("Improve directions");
      expect(html).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
      expect(html).not.toContain("/agent-src/bot/docket");
      const files = await filesPage(new Request("https://acme.pimwell.test/agent-src/bot/files?f=pi-agent/AGENTS.md", { headers }), w.configured, "agent-src/bot");
      expect(await files.text()).toContain("Only follow your operator.");
      await expect(repoSearch.run(ctx, repoSearch.parse({ project: "agent-src/bot", q: "operator" }))).rejects.toMatchObject({ status: 404 });
    }
    rootDirections = true;
    const headers = cookieHeaders(w.operator.token, "acme.pimwell.test");
    expect(await (await codePage(new Request("https://acme.pimwell.test/agent-src/bot/code", { headers }), w.configured, "agent-src/bot")).text()).toContain("Only follow your operator.");
  }, 20_000);

  it("lets the agent create and use its own, its operator push, admins read, and nobody else find it", async () => {
    const w = await world();
    expect((await w.git("/agent-src/bot.git", null)).status).toBe(401);
    expect((await w.git("/agent-src/bot.git", await w.gitAuth(w.other))).status).toBe(404);
    expect((await w.git("/agent-src/bot.git", await w.gitAuth(w.admin))).status).toBe(404);
    expect(w.created).toEqual([]);

    expect((await w.git("/agent-src/bot.git", w.botAuth)).status).toBe(200);
    expect(w.created).toEqual([w.slug]);
    const row = await env.HUB_DB.prepare("SELECT kind, slug FROM project WHERE slug = ?").bind(w.slug).first();
    expect(row).toEqual({ kind: "agent-src", slug: w.slug });

    expect((await w.git("/agent-src/bot.git", await w.gitAuth(w.operator), "git-receive-pack")).status).toBe(200);
    expect((await w.git("/agent-src/bot.git", await w.gitAuth(w.admin))).status).toBe(200);
    expect((await w.git("/agent-src/bot.git", await w.gitAuth(w.admin), "git-receive-pack")).status).toBe(403);
    expect((await w.git("/agent-src/bot.git", await w.gitAuth(w.other))).status).toBe(404);
    expect((await w.git("/agent-src/nobody.git", w.botAuth)).status).toBe(404);
    expect(w.created).toEqual([w.slug]);
  });

  it("accepts the agent's push, checking access again before publishing by the agent-src rule", async () => {
    const w = await world();
    expect((await w.git("/agent-src/bot.git", w.botAuth)).status).toBe(200);
    const res = await w.push(w.botAuth);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ok refs/heads/main");
    expect(w.published).toEqual(["refs/heads/main"]);
    const row = await env.HUB_DB.prepare("SELECT g.state FROM git_push g JOIN project p ON p.id = g.project_id WHERE p.kind = 'agent-src'").first<{ state: string }>();
    expect(row?.state).toBe("complete");
    expect((await w.push(await w.gitAuth(w.admin))).status).toBe(403);
  });

  it("can't be reached as a project repository, and stays out of every list, lookup and search", async () => {
    const w = await world();
    expect((await w.git("/agent-src/bot.git", w.botAuth)).status).toBe(200);
    expect((await w.git(`/${w.slug}.git`, w.botAuth)).status).toBe(401);
    expect(await getProjectByPath(env.HUB_DB, w.tenant.id, null, w.slug)).toBeNull();
    expect((await listProjects(env.HUB_DB, w.tenant.id, "active")).map((p) => p.slug)).not.toContain(w.slug);
    const as = (token: string) => (verb: string, body: unknown) => apiPost("acme.pimwell.test", verb, body, cookieHeaders(token, "acme.pimwell.test"));
    const admin = as(w.admin.token);
    expect(JSON.stringify(await (await admin("project.list", {})).json())).not.toContain("agent-src");
    expect(JSON.stringify(await (await admin("search.query", { q: "agent source" })).json())).not.toContain("agent-src");
    expect((await admin("work.create", { project: w.slug, kind: "snag", title: "x" })).status).toBe(404);
    expect((await admin("work.frontier", { project: w.slug })).status).toBe(400);
    expect((await SELF.fetch(`https://acme.pimwell.test/${w.slug}/docket`, { headers: cookieHeaders(w.admin.token, "acme.pimwell.test") })).status).toBe(404);
  });
});
