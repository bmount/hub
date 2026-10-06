import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { forwardGit, isGitPath } from "../src/http/git";
import { isValidTenantSlug } from "../src/tenant";
import { seedTenant } from "./helpers";

const forwarded = (res: Response) => res.headers.get("x-ardi-stub") === "1";

describe("git forwarding to Ardi", () => {
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

  it("matches only top-level .git smart-HTTP paths", () => {
    for (const p of ["/site.git/info/refs", "/a.b_c-d.git/git-upload-pack", "/Site9.git/git-receive-pack"]) expect({ p, ok: isGitPath(p) }).toEqual({ p, ok: true });
    for (const p of ["/site/info/refs", "/a/b.git/info/refs", "/site.git/info/refs/", "/-x.git/info/refs", "/site.git/objects/info/packs", "/site.git"]) expect({ p, ok: isGitPath(p) }).toEqual({ p, ok: false });
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
