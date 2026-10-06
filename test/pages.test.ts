import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, seedHuman, seedTenant } from "./helpers";

const cookie = (token: string) => ({ cookie: `pmw_session=${token}` });

describe("pages", () => {
  it("apex anonymous and signed-in", async () => {
    const anon = await SELF.fetch("https://pimwell.test/");
    expect(anon.status).toBe(200);
    expect(await anon.text()).toContain("invite link");
    const t = await seedTenant("acme");
    await seedTenant("blue");
    const h = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const html = await (await SELF.fetch("https://pimwell.test/", { headers: cookie(h.token) })).text();
    expect(html).toContain("https://acme.pimwell.test/");
    expect(html).not.toContain("https://blue.pimwell.test/");
    expect(html).toContain("/me/sessions");
    const root = await seedHuman("r@example.com", { is_root: true });
    const rootHtml = await (await SELF.fetch("https://pimwell.test/", { headers: cookie(root.token) })).text();
    expect(rootHtml).toContain("https://blue.pimwell.test/");
  });

  it("tenant home requires membership and shows projects", async () => {
    const t = await seedTenant("acme");
    const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const stranger = await seedHuman("s@example.com");
    await apiPost("acme.pimwell.test", "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(member.token));
    expect((await SELF.fetch("https://acme.pimwell.test/")).status).toBe(404);
    expect((await SELF.fetch("https://acme.pimwell.test/", { headers: cookie(stranger.token) })).status).toBe(404);
    const html = await (await SELF.fetch("https://acme.pimwell.test/", { headers: cookie(member.token) })).text();
    expect(html).toContain("ACME");
    expect(html).toContain("member");
    expect(html).toContain("site");
    expect(html).toContain('href="/archive"');
  });

  it("archive page lists archived projects only", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    await apiPost("acme.pimwell.test", "project.create", { slug: "old", kind: "repo", display_name: "Old" }, bearer(admin.token));
    await apiPost("acme.pimwell.test", "project.create", { slug: "new", kind: "repo", display_name: "New" }, bearer(admin.token));
    await apiPost("acme.pimwell.test", "project.archive", { slug: "old" }, bearer(admin.token));
    const html = await (await SELF.fetch("https://acme.pimwell.test/archive", { headers: cookie(admin.token) })).text();
    expect(html).toContain("old");
    expect(html).not.toContain(">new<");
  });

  it("unknown hosts and paths are 404", async () => {
    expect((await SELF.fetch("https://zzz.pimwell.test/")).status).toBe(404);
    expect((await SELF.fetch("https://evil.example/")).status).toBe(404);
    expect((await SELF.fetch("https://pimwell.test/nope")).status).toBe(404);
  });

  it("clears a stale cookie on page responses and not otherwise", async () => {
    const stale = { cookie: "pmw_session=pms_stale" };
    const r1 = await SELF.fetch("https://pimwell.test/me/sessions", { headers: stale });
    expect(r1.status).toBe(401);
    expect(r1.headers.get("set-cookie")).toContain("Max-Age=0");
    const t = await seedTenant("acme");
    const r2 = await SELF.fetch("https://acme.pimwell.test/", { headers: stale });
    expect(r2.status).toBe(404);
    expect(r2.headers.get("set-cookie")).toContain("Max-Age=0");
    const m = await seedHuman("m@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const r3 = await SELF.fetch("https://acme.pimwell.test/archive", { headers: cookie(m.token) });
    expect(r3.status).toBe(200);
    expect(r3.headers.get("set-cookie")).toBeNull();
  });
});
