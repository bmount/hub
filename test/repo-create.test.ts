import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../src/db/projects";
import { repoCreate, repoList } from "../src/verbs/code";
import { ArtifactsRest } from "../src/code/artifactsRest";
import { HubError } from "../src/errors";
import { projectCreate, projectUpdate, projectDelete } from "../src/verbs/project";
import type { Ctx } from "../src/auth/context";
import { setArdiForTest } from "../src/code/ardi";
import { apiPost, bearer, seedAgent, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
afterEach(() => { setArdiForTest(null); vi.restoreAllMocks(); });

const introspect = async (token: string, tenant = "acme") => (await (await SELF.fetch("https://pimwell.test/internal/introspect", {
  method: "POST", headers: { "content-type": "application/json", "x-hub-internal": "test-internal-secret" }, body: JSON.stringify({ token, tenant }),
})).json()) as { ok: boolean; role?: string; identity?: { id: string }; session?: { kind: string } };

type Seen = { path: string; name: unknown; token: string; during: Awaited<ReturnType<typeof introspect>> };

/** A git host that records each repo.create, and what the hub said about its credential at that moment. */
function fakeArdi(seen: Seen[], answer: () => Response = () => Response.json({ ok: true, result: { name: "x" } })) {
  setArdiForTest({
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const token = atob(new Headers(init?.headers).get("authorization")!.slice(6)).split(":")[1]!;
      seen.push({ path: url.pathname, name: JSON.parse(String(init?.body)).name, token, during: await introspect(token) });
      return answer();
    },
  } as unknown as Fetcher);
}

const projects = async () => (await env.HUB_DB.prepare("SELECT slug FROM project WHERE kind != 'channel' AND tenant_id != 'perf-synthetic-tenant' ORDER BY slug").all<{ slug: string }>()).results.map((r) => r.slug);

describe("Artifacts repository provisioning", () => {
  async function setup() {
    const tenant = await seedTenant("acme");
    const human = await seedHuman("member@example.invalid", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
    const ctx: Ctx = { ip: "127.0.0.1", host: { kind: "tenant", slug: "acme" }, apiToken: null, role: "member", authKind: "bearer", staleCookie: false, db: env.HUB_DB, env: { ...env, GIT_BACKEND: "artifacts", ARDI_REPO_CREATE: "on", ARTIFACTS_ACCOUNT_ID: "0".repeat(32), ARTIFACTS_API_TOKEN: "synthetic-secret" }, tenant, identity: human.identity, session: human.session, now: Date.now() };
    const input = { slug: "site", kind: "repo", display_name: "Site", namespace: null };
    let owned: string | null = null, mode = "success";
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        if (mode !== "refused") owned = JSON.parse(String(init.body)).description;
        if (mode !== "success") return Response.json({ success: false, errors: [{ code: 10000, message: "synthetic-secret" }] }, { status: 503 });
        return Response.json({ success: true, result: {} });
      }
      if (owned && mode === "unknown") return new Response("synthetic-secret", { status: 503 });
      if (mode === "foreign") owned = "another tenant's repository";
      if (!owned) return new Response("", { status: 404 });
      return Response.json({ success: true, result: { name: "site", remote: `https://${"0".repeat(32)}.artifacts.cloudflare.net/git/acme/site.git`, description: owned, default_branch: "main" } });
    });
    return { ctx, input, fetch, mode(value: string) { mode = value; } };
  }
  it("creates named repositories idempotently without moving the default, validates names and supports workspace defaults", async () => {
    const s = await setup();
    await projectCreate.run(s.ctx, s.input);
    const info = vi.spyOn(ArtifactsRest.prototype, "info").mockRejectedValue(new HubError(404, "not_found"));
    const create = vi.spyOn(ArtifactsRest.prototype, "create").mockResolvedValue(undefined);
    for (const name of ["api", "web"]) {
      const first = await repoCreate.run(s.ctx, repoCreate.parse({project:"site", name}));
      const again = await repoCreate.run(s.ctx, repoCreate.parse({project:"site", name}));
      expect(again).toEqual(first);
    }
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.every(c => c[1].length <= 63)).toBe(true);
    const list = await repoList.run(s.ctx, repoList.parse({project: "site"}));
    expect(list.repos.map(r => [r.name, r.is_default, r.clone_url])).toEqual([
      ["default", true, "https://acme.pimwell.test/site.git"],
      ["api", false, "https://acme.pimwell.test/site/api.git"],
      ["web", false, "https://acme.pimwell.test/site/web.git"],
    ]);
    for (const name of ["UPPER", "../escape", "nested/name", "", "x".repeat(64)]) {
      await expect(async () => repoCreate.run(s.ctx, repoCreate.parse({project:"site", name}))).rejects.toThrow();
    }
    await createProject(env.HUB_DB, {tenant_id: s.ctx.tenant!.id, namespace_id:null, slug:"desk", kind:"workspace", display_name:"Desk"}, Date.now());
    const first = await repoCreate.run(s.ctx, repoCreate.parse({project:"desk", name:"source"}));
    expect(first).toMatchObject({is_default:true, clone_url:"https://acme.pimwell.test/desk.git"});
    expect(await env.HUB_DB.prepare("SELECT storage_name FROM repository WHERE project_id = (SELECT id FROM project WHERE slug = 'site') AND is_default = 1").first<string>("storage_name")).toBe("site");
    info.mockRestore();create.mockRestore();
  });
  it("adds code to a tracker, provisions only once, enables named repositories in any kind and deletes added parts", async () => {
    const s = await setup();
    const p = await createProject(env.HUB_DB,{tenant_id:s.ctx.tenant!.id,namespace_id:null,slug:"tasks",kind:"tracker",display_name:"Tasks"},Date.now());
    vi.spyOn(ArtifactsRest.prototype,"info").mockRejectedValue(new HubError(404,"not_found"));
    const create = vi.spyOn(ArtifactsRest.prototype,"create").mockResolvedValue(undefined);
    const args = projectUpdate.parse({project:"tasks",add:["repo","wiki"]});
    const first = await projectUpdate.run(s.ctx,args);
    expect(first.project.kind).toBe("tracker");
    expect(first.parts).toEqual(["docket","repo","wiki"]);
    const again = await projectUpdate.run(s.ctx,args);
    expect(again.parts).toEqual(first.parts);
    expect(create).toHaveBeenCalledTimes(1);
    expect((await repoList.run(s.ctx,repoList.parse({project:"tasks"}))).repos[0]).toMatchObject({is_default:true,clone_url:"https://acme.pimwell.test/tasks.git"});
    await expect(projectUpdate.run(s.ctx,projectUpdate.parse({project:"tasks",remove:["repo"]}))).rejects.toThrow("repositories");
    const wiki = await createProject(env.HUB_DB,{tenant_id:s.ctx.tenant!.id,namespace_id:null,slug:"pages",kind:"wiki",display_name:"Pages"},Date.now());
    await repoCreate.run(s.ctx,repoCreate.parse({project:"pages",name:"code"}));
    expect(JSON.parse((await env.HUB_DB.prepare("SELECT parts FROM project WHERE id = ?").bind(wiki.id).first<string>("parts"))!)).toContain("repo");
    // A tracker with added code must purge remote stores, not just its original template's tables.
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(p.id).run();
    s.ctx.role = "admin"; s.ctx.authKind = "cookie";
    const purge = vi.spyOn(ArtifactsRest.prototype,"deleteProject").mockResolvedValue(undefined);
    await projectDelete.run(s.ctx,projectDelete.parse({project:"tasks",confirm:"tasks"}));
    expect(purge).toHaveBeenCalledTimes(1);
    expect(await env.HUB_DB.prepare("SELECT 1 FROM project WHERE id = ?").bind(p.id).first()).toBeNull();
    expect(await env.HUB_DB.prepare("SELECT 1 FROM repository WHERE project_id = ?").bind(p.id).first()).toBeNull();
  });
  it("creates an owned repo and records its mapping", async () => {
    const s = await setup();
    await projectCreate.run(s.ctx, s.input);
    expect(await projects()).toEqual(["site"]);
    expect(await env.HUB_DB.prepare("SELECT count(*) n FROM git_repository").first<number>("n")).toBe(1);
  });
  it("reconciles a lost create response instead of orphaning the repository", async () => {
    const s = await setup();s.mode("lost");
    await projectCreate.run(s.ctx, s.input);
    expect(await projects()).toEqual(["site"]);
    expect(s.fetch.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
  });
  it("rolls back a confirmed refusal, exposing codes but no upstream prose", async () => {
    const s = await setup();s.mode("refused");
    await expect(projectCreate.run(s.ctx, s.input)).rejects.toThrow("HTTP 503; codes 10000");
    expect(await projects()).toEqual([]);
    expect(await env.HUB_DB.prepare("SELECT count(*) n FROM git_repository").first<number>("n")).toBe(0);
    s.mode("success");await projectCreate.run(s.ctx, s.input);
    expect(await projects()).toEqual(["site"]);
  });
  it("never adopts or overwrites a foreign storage ownership marker", async () => {
    const s = await setup();s.mode("foreign");
    await expect(projectCreate.run(s.ctx, s.input)).rejects.toThrow("already owned");
    expect(await projects()).toEqual([]);
    expect(s.fetch.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(0);
  });
  it("does not resume archived, deleting, or disabled pending projects", async () => {
    const s = await setup();s.mode("unknown");
    await expect(projectCreate.run(s.ctx, s.input)).rejects.toThrow("project retained");
    s.mode("success");
    s.ctx.env.ARDI_REPO_CREATE = "off";
    await expect(projectCreate.run(s.ctx, s.input)).rejects.toThrow("disabled");
    s.ctx.env.ARDI_REPO_CREATE = "on";
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE slug = 'site'").run();
    await expect(projectCreate.run(s.ctx, s.input)).rejects.toThrow("archived");
    await env.HUB_DB.prepare("UPDATE project SET state = 'active' WHERE slug = 'site'").run();
    const id = await env.HUB_DB.prepare("SELECT id FROM project WHERE slug = 'site'").first<string>("id");
    await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, 'deleting')").bind(`project_delete:v1:${s.ctx.tenant!.id}:${id}`).run();
    await expect(projectCreate.run(s.ctx, s.input)).rejects.toThrow("being deleted");
  });
  it("retains the project ID on unknown outcomes and safely resumes the same create", async () => {
    const s = await setup();s.mode("unknown");
    await expect(projectCreate.run(s.ctx, s.input)).rejects.toThrow("project retained");
    const id = await env.HUB_DB.prepare("SELECT id FROM project WHERE slug = 'site'").first<string>("id");
    await expect(projectCreate.run(s.ctx, s.input)).rejects.toThrow();
    expect(await env.HUB_DB.prepare("SELECT id FROM project WHERE slug = 'site'").first<string>("id")).toBe(id);
    s.mode("success");await projectCreate.run(s.ctx, s.input);
    expect(await env.HUB_DB.prepare("SELECT id FROM project WHERE slug = 'site'").first<string>("id")).toBe(id);
    expect(await env.HUB_DB.prepare("SELECT count(*) n FROM meta WHERE key LIKE 'repo-provision:%'").first<number>("n")).toBe(0);
    expect(s.fetch.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
    await expect(projectCreate.run(s.ctx, s.input)).rejects.toThrow();
  });
});

describe("making a repo project creates its repository", () => {
  it("as a member, with a one-shot admin credential that is revoked right after", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const seen: Seen[] = [];
    fakeArdi(seen);
    const res = await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(h.token));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/t/acme/api/repo.create");
    expect(seen[0]!.name).toBe("site");
    expect(seen[0]!.during).toMatchObject({ ok: true, role: "admin", identity: { id: h.identity.id }, session: { kind: "repo_create" } });
    expect((await introspect(seen[0]!.token)).ok).toBe(false);
    expect(await projects()).toEqual(["site"]);
  });

  it("as an agent, recorded as the agent", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const a = await seedAgent(t, h.identity);
    const seen: Seen[] = [];
    fakeArdi(seen);
    expect((await apiPost(HOST, "project.create", { slug: "tools", kind: "repo", display_name: "Tools" }, bearer(a.token))).status).toBe(200);
    expect(seen[0]!.during).toMatchObject({ ok: true, role: "admin", identity: { id: a.agent.identity.id } });
  });

  it("the one-shot credential works nowhere else", async () => {
    const t = await seedTenant("acme");
    await seedTenant("blue");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    let other: Awaited<ReturnType<typeof introspect>> | null = null;
    let api = 0;
    setArdiForTest({
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const token = atob(new Headers(init?.headers).get("authorization")!.slice(6)).split(":")[1]!;
        other = await introspect(token, "blue");
        api = (await apiPost(HOST, "project.list", {}, bearer(token))).status;
        return Response.json({ ok: true, result: { name: "site" } });
      },
    } as unknown as Fetcher);
    await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(h.token));
    expect(other).toEqual({ ok: false });
    // Treated as no credential at all.
    expect(api).toBe((await apiPost(HOST, "project.list", {})).status);
    expect(api).not.toBe(200);
  });

  it("no repository, no project: a refusal or an unreachable git host leaves nothing behind", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    fakeArdi([], () => Response.json({ ok: false, error: { message: "invalid repository name" } }, { status: 400 }));
    expect((await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(h.token))).status).toBe(502);
    setArdiForTest({ fetch: async () => { throw new Error("down"); } } as unknown as Fetcher);
    expect((await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(h.token))).status).toBe(503);
    expect(await projects()).toEqual([]);
    const live = await env.HUB_DB.prepare("SELECT count(*) AS n FROM session WHERE kind = 'repo_create' AND revoked_at IS NULL").first<{ n: number }>();
    expect(live!.n).toBe(0);
  });

  it("a repository that already exists becomes the project's", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    fakeArdi([], () => Response.json({ ok: false, error: { class: "conflict", message: "repository site already exists" } }, { status: 409 }));
    expect((await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(h.token))).status).toBe(200);
    expect(await projects()).toEqual(["site"]);
  });

  it("off unless ARDI_REPO_CREATE is on: the project is made without touching the git host", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const seen: Seen[] = [];
    fakeArdi(seen);
    const was = env.ARDI_REPO_CREATE;
    (env as { ARDI_REPO_CREATE?: string }).ARDI_REPO_CREATE = undefined;
    try {
      expect((await apiPost(HOST, "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(h.token))).status).toBe(200);
    } finally {
      (env as { ARDI_REPO_CREATE?: string }).ARDI_REPO_CREATE = was;
    }
    expect(seen).toHaveLength(0);
    expect(await projects()).toEqual(["site"]);
  });

  it("trackers have no repository", async () => {
    const t = await seedTenant("acme");
    const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const seen: Seen[] = [];
    fakeArdi(seen);
    expect((await apiPost(HOST, "project.create", { slug: "plans", kind: "tracker", display_name: "Plans" }, bearer(h.token))).status).toBe(200);
    expect(seen).toHaveLength(0);
  });
});
