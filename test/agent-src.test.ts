// An agent's own source repository at /agent-src/<agent>.git (docs/ops/agent-src.md): who may read and push, creation
// on first use, and that the hidden project behind it never shows up where people browse projects.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactGit } from "../src/http/artifactGit";
import { clearArtifactTokensForTest } from "../src/code/artifactsRest";
import { agentSrcSlug } from "../src/code/agentSrc";
import { createGitSession } from "../src/db/sessions";
import { getProjectByPath, listProjects } from "../src/db/projects";
import { packet } from "../src/code/gitProtocol";
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
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname.endsWith(".artifacts.cloudflare.net")) return new Response(new Uint8Array([...packet("# service=git-upload-pack\n"), ...new TextEncoder().encode("0000"), ...packet(`${"1".repeat(40)} refs/heads/main\n`), ...new TextEncoder().encode("0000")]));
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
  return { tenant, operator, admin, other, bot, created, gitAuth, git, botAuth: `Basic ${btoa(`x:${bot.token}`)}`, slug: agentSrcSlug(bot.agent.identity.id) };
}

describe("agent source repositories", () => {
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
