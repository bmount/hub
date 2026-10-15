import { env, SELF, createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import gitProxy from "../git-proxy/index";
import { forwardGit, isGitPath } from "../src/http/git";
import { isValidTenantSlug } from "../src/tenant";
import { createProject } from "../src/db/projects";
import { seedHuman, seedTenant } from "./helpers";
import { createGitSession } from "../src/db/sessions";
import { ArtifactsRest } from "../src/code/artifactsRest";
import { repoOwnership } from "../src/code/artifactPush";

afterEach(() => vi.restoreAllMocks());

const forwarded = (res: Response) => res.headers.get("x-ardi-stub") === "1";

describe("git forwarding to Ardi", () => {
  it("overlaps the hub tenant lookup with its independently authorizing Git service", async () => {
    const tenant = await seedTenant("acme");
    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });
    const configured = { ...env,
      HUB_DB: { prepare: () => ({ bind: () => ({ first: async () => { await started; return tenant; } }) }) },
      GIT_PROXY: { fetch: async () => { release(); return new Response("Git service response"); } },
    } as any;
    const response = await forwardGit(new Request("https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack"), configured);
    expect(await response!.text()).toBe("Git service response");
  });
  it("discards proxy responses and errors for missing or inactive tenants", async () => {
    const tenant = await seedTenant("acme");
    await env.HUB_DB.prepare("UPDATE tenant SET state='archived' WHERE id=?").bind(tenant.id).run();
    let cancelled = 0;
    const configured = { ...env, GIT_PROXY: { fetch: async () => new Response(new ReadableStream({ cancel() { cancelled++; } })) } } as any;
    for (const host of ["acme", "missing"]) {
      expect((await forwardGit(new Request(`https://${host}.pimwell.test/site.git/info/refs?service=git-upload-pack`), configured))!.status).toBe(404);
    }
    expect(cancelled).toBe(2);
    configured.GIT_PROXY.fetch = async () => { throw new Error("proxy unavailable"); };
    expect((await forwardGit(new Request("https://missing.pimwell.test/site.git/info/refs?service=git-upload-pack"), configured))!.status).toBe(404);
    await env.HUB_DB.prepare("UPDATE tenant SET state='active' WHERE id=?").bind(tenant.id).run();
    await expect(forwardGit(new Request("https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack"), configured)).rejects.toThrow("proxy unavailable");
  });
  it("forwards info/refs on an active tenant host unchanged", async () => {
    await seedTenant("acme");
    const res = await SELF.fetch("https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack", {
      headers: { authorization: "Basic eDpwbXNfeA==", "git-protocol": "version=2" },
    });
    expect(res.status).toBe(200);
    expect(forwarded(res)).toBe(true);
    expect(await res.json()).toMatchObject({
      method: "GET", url: "https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack",
      authorization: "Basic eDpwbXNfeA==", gitProtocol: "version=2", cookie: null, body: "",
    });
  });

  it("streams upload-pack and receive-pack bodies through", async () => {
    await seedTenant("acme");
    for (const [op, type] of [["git-upload-pack", "application/x-git-upload-pack-request"], ["git-receive-pack", "application/x-git-receive-pack-request"]] as [string, string][]) {
      const res = await SELF.fetch(`https://acme.pimwell.test/site.git/${op}`, {
        method: "POST", headers: { "content-type": type }, body: new TextEncoder().encode("0014command=ls-refs\n0000"),
      });
      expect(forwarded(res)).toBe(true);
      expect(await res.json()).toMatchObject({ method: "POST", url: `https://acme.pimwell.test/site.git/${op}`, contentType: type, body: "0014command=ls-refs\n0000" });
    }
  });

  it("strips the hub cookie", async () => {
    await seedTenant("acme");
    const res = await SELF.fetch("https://acme.pimwell.test/site.git/info/refs?service=git-receive-pack", { headers: { cookie: "pmw_session=pms_abc; other=1" } });
    expect(forwarded(res)).toBe(true);
    expect(((await res.json()) as any).cookie).toBeNull();
  });

  it("streams a multi-MB body and Ardi receives every byte", async () => {
    await seedTenant("acme");
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    let sent = 0;
    const total = 5;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { if (sent++ < total) c.enqueue(chunk); else c.close(); },
    });
    const res = await SELF.fetch("https://acme.pimwell.test/site.git/git-receive-pack", {
      method: "POST", headers: { "content-type": "application/x-git-receive-pack-request" }, body, duplex: "half",
    } as RequestInit);
    expect(forwarded(res)).toBe(true);
    expect(((await res.json()) as any).length).toBe(total * 1024 * 1024);
  });

  it("passes Ardi's 401 challenge through unchanged, with no content-security-policy", async () => {
    await seedTenant("acme");
    const res = await SELF.fetch("https://acme.pimwell.test/site.git/info/refs?service=git-receive-pack", { headers: { "x-stub-401": "1" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="ardi"');
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(await res.text()).toBe("denied\n");
  });

  it("forwards a dot-segment path with the normalised URL", async () => {
    await seedTenant("acme");
    const res = await SELF.fetch("https://acme.pimwell.test/x/../site.git/info/refs?service=git-upload-pack");
    expect(forwarded(res)).toBe(true);
    expect(((await res.json()) as any).url).toBe("https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack");
  });

  it("does not forward Ardi API paths", async () => {
    await seedTenant("acme");
    const res = await SELF.fetch("https://acme.pimwell.test/t/acme/api/x");
    expect(forwarded(res)).toBe(false);
  });

  it("drops client-supplied x-ardi-* headers before forwarding", async () => {
    await seedTenant("acme");
    const res = await SELF.fetch("https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack", {
      headers: { "x-ardi-principal": "admin", "X-Ardi-Tenant": "blue", "x-other": "1" },
    });
    expect(forwarded(res)).toBe(true);
    expect(((await res.json()) as any).xArdi).toEqual([]);
  });

  it.each([false, true])("routes authenticated Artifacts from one live authorization batch (named=%s)", async named => {
    const tenant = await seedTenant("acme");
    const human = await seedHuman("git@example.invalid", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
    const project = await createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
    await env.HUB_DB.prepare("INSERT INTO repository (tenant_id, project_id, name, storage_name, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(tenant.id, project.id, named ? "secondary" : "default", "site-storage", named ? 0 : 1, Date.now()).run();
    const git = await createGitSession(env.HUB_DB, { identity_id: human.identity.id, tenant_id: tenant.id, label: "test" }, Date.now());
    const info = vi.spyOn(ArtifactsRest.prototype, "info").mockResolvedValue({ name: "site-storage", remote: "", description: repoOwnership(tenant.id, project.id), default_branch: "main", read_only: false });
    vi.spyOn(ArtifactsRest.prototype, "repoToken").mockResolvedValue("test");
    const storage = vi.spyOn(ArtifactsRest.prototype, "git").mockImplementation(async () => new Response("advertisement"));
    let statements = 0, batches = 0;
    const db = { prepare: (sql: string) => { statements++;return env.HUB_DB.prepare(sql); }, batch: (queries: D1PreparedStatement[]) => { batches++;return env.HUB_DB.batch(queries); } };
    const configured = { ...env, HUB_DB: db, GIT_BACKEND: "artifacts", ARTIFACTS_ACCOUNT_ID: "0".repeat(32), ARTIFACTS_API_TOKEN: "test", HUB: { fetch: () => new Response("hub") } } as any;
    const request = () => new Request(`https://acme.pimwell.test/site${named ? "/secondary" : ""}.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Basic ${btoa(`ignored:${git.token}`)}` } });
    expect(await (await gitProxy.fetch(request(), configured, createExecutionContext())).text()).toBe("advertisement");
    expect(batches).toBe(1);expect(statements).toBe(8);expect(info).toHaveBeenCalledTimes(1);
    // The fast path must not turn a previous grant into cached authorization.
    await env.HUB_DB.prepare("UPDATE membership SET state='archived' WHERE identity_id=? AND tenant_id=?").bind(human.identity.id, tenant.id).run();
    expect((await gitProxy.fetch(request(), configured, createExecutionContext())).status).toBe(401);
    expect(storage).toHaveBeenCalledTimes(1);
    await env.HUB_DB.prepare("UPDATE tenant SET state='archived' WHERE id=?").bind(tenant.id).run();
    expect((await gitProxy.fetch(request(), configured, createExecutionContext())).status).toBe(404);
    expect(storage).toHaveBeenCalledTimes(1);
  });

  it("checks tenant state in the standalone git proxy before dispatch", async () => {
    const acme = await seedTenant("acme");
    let calls = 0;
    const proxyEnv = { ...env, HUB: { fetch: () => new Response("hub") }, ARDI: { fetch: () => { calls++;return new Response("ardi", { headers: { "x-ardi-stub": "1" } }); } } } as any;
    expect((await gitProxy.fetch(new Request("https://acme.pimwell.test/site.git/info/refs"), proxyEnv, createExecutionContext())).headers.get("x-ardi-stub")).toBe("1");
    await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(acme.id).run();
    const archived = await gitProxy.fetch(new Request("https://acme.pimwell.test/site.git/info/refs"), proxyEnv, createExecutionContext());
    expect(archived.status).toBe(404);expect(calls).toBe(1);
  });

  it("tracks legacy receive-pack forwards until the upstream body is consumed", async () => {
    const acme = await seedTenant("acme"), project = await createProject(env.HUB_DB, { tenant_id: acme.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
    await env.HUB_DB.prepare("INSERT INTO git_repository (tenant_id, project_id, imported_at) VALUES (?, ?, ?)").bind(acme.id, project.id, Date.now()).run();
    const proxyEnv = {
      ...env, GIT_BACKEND: "ardi", HUB: { fetch: () => new Response("hub") },
      ARDI: { fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("ok"));c.close(); } }), { status: 200, headers: { "x-ardi-stub": "1" } }) },
    } as any;
    const res = await gitProxy.fetch(new Request("https://acme.pimwell.test/site.git/git-receive-pack", { method: "POST", body: "pack" }), proxyEnv, createExecutionContext());
    expect(res.headers.get("x-ardi-stub")).toBe("1");
    expect((await env.HUB_DB.prepare("SELECT state FROM git_legacy_forward WHERE project_id = ?").bind(project.id).first<{ state: string }>())!.state).toBe("forwarding");
    expect(await res.text()).toBe("ok");
    expect(await env.HUB_DB.prepare("SELECT state, status FROM git_legacy_forward WHERE project_id = ?").bind(project.id).first()).toMatchObject({ state: "complete", status: 200 });
  });

  it("marks forwarded legacy pushes unknown when upstream dispatch is ambiguous", async () => {
    const acme = await seedTenant("acme"), project = await createProject(env.HUB_DB, { tenant_id: acme.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
    await env.HUB_DB.prepare("INSERT INTO git_repository (tenant_id, project_id, imported_at) VALUES (?, ?, ?)").bind(acme.id, project.id, Date.now()).run();
    const proxyEnv = { ...env, GIT_BACKEND: "ardi", HUB: { fetch: () => new Response("hub") }, ARDI: { fetch: async () => { throw new Error("lost after send"); } } } as any;
    await expect(gitProxy.fetch(new Request("https://acme.pimwell.test/site.git/git-receive-pack", { method: "POST", body: "pack" }), proxyEnv, createExecutionContext())).rejects.toThrow("lost after send");
    expect(await env.HUB_DB.prepare("SELECT state, status FROM git_legacy_forward WHERE project_id = ?").bind(project.id).first()).toMatchObject({ state: "unknown", status: null });
  });

  it("refuses newly fenced legacy pushes but keeps fetches and other repositories working", async () => {
    const acme = await seedTenant("acme"), project = await createProject(env.HUB_DB, { tenant_id: acme.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
    await env.HUB_DB.prepare("INSERT INTO git_repository (tenant_id, project_id, imported_at, legacy_write_fenced_at) VALUES (?, ?, ?, ?)").bind(acme.id, project.id, Date.now(), Date.now()).run();
    let calls = 0;
    const proxyEnv = { ...env, GIT_BACKEND: "ardi", HUB: { fetch: () => new Response("hub") }, ARDI: { fetch: () => { calls++;return new Response("ardi", { headers: { "x-ardi-stub": "1" } }); } } } as any;
    const refused = await gitProxy.fetch(new Request("https://acme.pimwell.test/site.git/git-receive-pack", { method: "POST", body: "pack" }), proxyEnv, createExecutionContext());
    expect(refused.status).toBe(403);expect(calls).toBe(0);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM git_legacy_forward").first()).toMatchObject({ n: 0 });
    expect((await gitProxy.fetch(new Request("https://acme.pimwell.test/site.git/git-upload-pack", { method: "POST", body: "want" }), proxyEnv, createExecutionContext())).headers.get("x-ardi-stub")).toBe("1");
    expect((await gitProxy.fetch(new Request("https://acme.pimwell.test/other.git/git-receive-pack", { method: "POST", body: "pack" }), proxyEnv, createExecutionContext())).headers.get("x-ardi-stub")).toBe("1");
  });

  it("404s unknown and archived tenants without forwarding", async () => {
    const unknown = await SELF.fetch("https://nosuch.pimwell.test/site.git/info/refs?service=git-upload-pack");
    expect(unknown.status).toBe(404);
    expect(forwarded(unknown)).toBe(false);
    const acme = await seedTenant("acme");
    await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(acme.id).run();
    const archived = await SELF.fetch("https://acme.pimwell.test/site.git/info/refs?service=git-upload-pack");
    expect(archived.status).toBe(404);
    expect(forwarded(archived)).toBe(false);
  });

  it("leaves other paths and hosts to the hub", async () => {
    await seedTenant("acme");
    for (const path of ["/", "/site.git", "/site.git/HEAD", "/site.git/info/refs/x", "/ns/site.git/info/refs", "/site/info/refs", "/.git/info/refs", "/%73ite.git/info/refs", "/me"]) {
      const res = await SELF.fetch(`https://acme.pimwell.test${path}`);
      expect({ path, forwarded: forwarded(res) }).toEqual({ path, forwarded: false });
    }
    for (const host of ["pimwell.test", "www.pimwell.test", "git.pimwell.test"]) {
      const res = await SELF.fetch(`https://${host}/site.git/info/refs`);
      expect({ host, status: res.status, forwarded: forwarded(res) }).toEqual({ host, status: 404, forwarded: false });
    }
    const healthz = await SELF.fetch("https://acme.pimwell.test/healthz");
    expect(await healthz.text()).toBe("ok");
  });

  it("matches top-level and named .git smart-HTTP paths", () => {
    for (const p of ["/site.git/info/refs", "/a.b_c-d.git/git-upload-pack", "/Site9.git/git-receive-pack"]) expect({ p, ok: isGitPath(p) }).toEqual({ p, ok: true });
    for (const p of ["/site/info/refs", "/a/b/c.git/info/refs", "/site.git/info/refs/", "/-x.git/info/refs", "/site.git/objects/info/packs", "/site.git"]) expect({ p, ok: isGitPath(p) }).toEqual({ p, ok: false });
  });

  it("answers 503 when the ARDI binding is missing", async () => {
    await seedTenant("acme");
    const res = await forwardGit(new Request("https://acme.pimwell.test/site.git/info/refs"), { ...env, ARDI: undefined });
    expect(res!.status).toBe(503);
    expect(await res!.text()).toBe("git service unavailable\n");
  });

  it("reserves git and ardi as tenant labels", () => {
    expect(isValidTenantSlug("git")).toBe(false);
    expect(isValidTenantSlug("ardi")).toBe(false);
  });
});
