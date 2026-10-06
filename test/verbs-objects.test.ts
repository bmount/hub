import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, seedHuman, seedTenant } from "./helpers";
import { listEvents } from "../src/db/events";
import { getTenantBySlug } from "../src/db/tenants";

describe("tenant verbs", () => {
  it("root creates, lists, archives and unarchives a tenant from the apex", async () => {
    const root = await seedHuman("r@example.com", { is_root: true });
    const made = await apiPost("pimwell.test", "tenant.create", { slug: "acme", display_name: "Acme" }, bearer(root.token));
    expect(made.status).toBe(200);
    const list = await apiPost("pimwell.test", "tenant.list", {}, bearer(root.token));
    expect(((await list.json()) as any).result.tenants.map((t: any) => t.slug)).toEqual(["acme"]);
    expect((await apiPost("pimwell.test", "tenant.archive", { slug: "acme" }, bearer(root.token))).status).toBe(200);
    expect((await apiPost("pimwell.test", "tenant.archive", { slug: "acme" }, bearer(root.token))).status).toBe(409);
    expect((await apiPost("pimwell.test", "tenant.archive", { slug: "nope" }, bearer(root.token))).status).toBe(404);
    expect((await getTenantBySlug(env.HUB_DB, "acme"))?.state).toBe("archived");
    expect((await apiPost("pimwell.test", "tenant.unarchive", { slug: "acme" }, bearer(root.token))).status).toBe(200);
    const t = await getTenantBySlug(env.HUB_DB, "acme");
    const events = await listEvents(env.HUB_DB, t!.id, 10);
    expect(events.map((e) => e.kind)).toEqual(["tenant.unarchive", "tenant.archive", "tenant.create"]);
    expect(events[0]!.identity_id).toBe(root.identity.id);
    expect(events[0]!.session_id).toBe(root.session.id);
  });

  it("non-root cannot create tenants; tenant verbs are not served on a tenant host", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    expect((await apiPost("pimwell.test", "tenant.create", { slug: "blue", display_name: "Blue" }, bearer(admin.token))).status).toBe(403);
    const root = await seedHuman("r@example.com", { is_root: true });
    expect((await apiPost("acme.pimwell.test", "tenant.create", { slug: "blue", display_name: "Blue" }, bearer(root.token))).status).toBe(404);
  });
});

describe("namespace and project verbs", () => {
  it("admin creates a namespace, member creates projects, reader lists", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const reader = await seedHuman("v@example.com", { memberships: [{ tenant_id: t.id, role: "reader" }] });

    expect((await apiPost("acme.pimwell.test", "namespace.create", { slug: "research", display_name: "Research" }, bearer(member.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "namespace.create", { slug: "research", display_name: "Research" }, bearer(admin.token))).status).toBe(200);

    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(reader.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(member.token))).status).toBe(200);
    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "site", kind: "repo", display_name: "R Site", namespace: "research" }, bearer(member.token))).status).toBe(200);
    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "x", kind: "repo", display_name: "X", namespace: "missing" }, bearer(member.token))).status).toBe(409);
    expect((await apiPost("acme.pimwell.test", "project.create", { slug: "research", kind: "repo", display_name: "Clash" }, bearer(member.token))).status).toBe(409);

    const list = await apiPost("acme.pimwell.test", "project.list", {}, bearer(reader.token));
    const body = (await list.json()) as any;
    expect(body.result.namespaces.map((n: any) => n.slug)).toEqual(["research"]);
    expect(body.result.projects.map((p: any) => p.path)).toEqual(["research/site", "site"]);
  });

  it("archiving a namespace hides its projects; archive is admin only", async () => {
    const t = await seedTenant("acme");
    const admin = await seedHuman("a@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    await apiPost("acme.pimwell.test", "namespace.create", { slug: "research", display_name: "Research" }, bearer(admin.token));
    await apiPost("acme.pimwell.test", "project.create", { slug: "a", kind: "repo", display_name: "A", namespace: "research" }, bearer(member.token));
    await apiPost("acme.pimwell.test", "project.create", { slug: "b", kind: "repo", display_name: "B" }, bearer(member.token));
    expect((await apiPost("acme.pimwell.test", "project.archive", { slug: "b" }, bearer(member.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "namespace.archive", { slug: "research" }, bearer(admin.token))).status).toBe(200);
    const active = (await (await apiPost("acme.pimwell.test", "project.list", {}, bearer(member.token))).json()) as any;
    expect(active.result.projects.map((p: any) => p.path)).toEqual(["b"]);
    const archived = (await (await apiPost("acme.pimwell.test", "project.list", { state: "archived" }, bearer(member.token))).json()) as any;
    expect(archived.result.projects.map((p: any) => p.path)).toEqual(["research/a"]);
    expect((await apiPost("acme.pimwell.test", "project.archive", { slug: "a", namespace: "research" }, bearer(admin.token))).status).toBe(409);
    expect((await apiPost("acme.pimwell.test", "project.unarchive", { slug: "a", namespace: "research" }, bearer(admin.token))).status).toBe(200);
  });
});
