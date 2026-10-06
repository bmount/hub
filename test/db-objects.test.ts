import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenant, getTenantBySlug, listTenants, setTenantState } from "../src/db/tenants";
import { createNamespace, listNamespaces, setNamespaceState } from "../src/db/namespaces";
import { createProject, getProjectById, getProjectByPath, listProjects, setProjectState } from "../src/db/projects";
import { listEvents, recordEvent } from "../src/db/events";

const db = () => env.HUB_DB;
const now = 1_700_000_000_000;

describe("tenants", () => {
  it("creates, finds, lists by state, archives", async () => {
    const t = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    expect(t.state).toBe("active");
    expect((await getTenantBySlug(db(), "acme"))?.id).toBe(t.id);
    expect((await listTenants(db(), "active")).map((x) => x.slug)).toEqual(["acme"]);
    expect(await setTenantState(db(), t.id, "archived", now + 1)).toBe(true);
    expect(await listTenants(db(), "active")).toEqual([]);
    expect((await listTenants(db(), "archived")).map((x) => x.slug)).toEqual(["acme"]);
  });
  it("rejects reserved and duplicate slugs", async () => {
    await expect(createTenant(db(), { slug: "mcp", display_name: "x" }, now)).rejects.toMatchObject({ status: 400 });
    await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    await expect(createTenant(db(), { slug: "acme", display_name: "Acme 2" }, now)).rejects.toMatchObject({ status: 409 });
  });
});

describe("namespaces and projects", () => {
  it("creates projects at top level and under a namespace, and finds by path", async () => {
    const t = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    const ns = await createNamespace(db(), { tenant_id: t.id, slug: "research", display_name: "Research" }, now);
    const top = await createProject(db(), { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, now);
    const inner = await createProject(db(), { tenant_id: t.id, namespace_id: ns.id, slug: "site", kind: "repo", display_name: "Research site" }, now);
    expect((await getProjectByPath(db(), t.id, null, "site"))?.id).toBe(top.id);
    expect((await getProjectByPath(db(), t.id, "research", "site"))?.id).toBe(inner.id);
    expect((await listProjects(db(), t.id, "active")).length).toBe(2);
  });

  it("rejects a top-level project slug that matches a namespace slug, and the reverse", async () => {
    const t = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    await createNamespace(db(), { tenant_id: t.id, slug: "research", display_name: "Research" }, now);
    await expect(
      createProject(db(), { tenant_id: t.id, namespace_id: null, slug: "research", kind: "repo", display_name: "x" }, now),
    ).rejects.toMatchObject({ status: 409 });
    await createProject(db(), { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, now);
    await expect(createNamespace(db(), { tenant_id: t.id, slug: "site", display_name: "x" }, now)).rejects.toMatchObject({ status: 409 });
  });

  it("archiving a namespace archives its projects and unarchiving restores them", async () => {
    const t = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    const ns = await createNamespace(db(), { tenant_id: t.id, slug: "research", display_name: "Research" }, now);
    await createProject(db(), { tenant_id: t.id, namespace_id: ns.id, slug: "a", kind: "repo", display_name: "A" }, now);
    const top = await createProject(db(), { tenant_id: t.id, namespace_id: null, slug: "b", kind: "repo", display_name: "B" }, now);
    await setNamespaceState(db(), t.id, ns.id, "archived");
    expect((await listProjects(db(), t.id, "active")).map((p) => p.id)).toEqual([top.id]);
    expect((await listNamespaces(db(), t.id, "archived")).length).toBe(1);
    await setNamespaceState(db(), t.id, ns.id, "active");
    expect((await listProjects(db(), t.id, "active")).length).toBe(2);
    expect(await setProjectState(db(), t.id, top.id, "archived")).toBe(true);
    expect(await setProjectState(db(), t.id, "nope", "archived")).toBe(false);
  });

  it("cross-tenant state change is a no-op", async () => {
    const a = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    const b = await createTenant(db(), { slug: "blue", display_name: "Blue" }, now);
    const p = await createProject(db(), { tenant_id: a.id, namespace_id: null, slug: "site", kind: "repo", display_name: "A" }, now);
    expect(await setProjectState(db(), b.id, p.id, "archived")).toBe(false);
    expect((await getProjectById(db(), a.id, p.id))?.state).toBe("active");
    expect(await getProjectById(db(), b.id, p.id)).toBeNull();
  });

  it("isolates tenants", async () => {
    const a = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    const b = await createTenant(db(), { slug: "blue", display_name: "Blue" }, now);
    await createProject(db(), { tenant_id: a.id, namespace_id: null, slug: "site", kind: "repo", display_name: "A" }, now);
    await createProject(db(), { tenant_id: b.id, namespace_id: null, slug: "site", kind: "repo", display_name: "B" }, now);
    expect((await listProjects(db(), a.id, "active")).map((p) => p.display_name)).toEqual(["A"]);
    expect((await getProjectByPath(db(), b.id, null, "site"))?.display_name).toBe("B");
  });
});

describe("events", () => {
  it("records and lists newest first", async () => {
    const t = await createTenant(db(), { slug: "acme", display_name: "Acme" }, now);
    await recordEvent(db(), { tenant_id: t.id, identity_id: null, session_id: null, kind: "tenant.create", target_kind: "tenant", target_id: t.id, summary: "Created Acme" }, now);
    await recordEvent(db(), { tenant_id: t.id, identity_id: null, session_id: null, kind: "project.create", target_kind: "project", target_id: "p", summary: "Created p" }, now + 5);
    const rows = await listEvents(db(), t.id, 10);
    expect(rows.map((r) => r.kind)).toEqual(["project.create", "tenant.create"]);
  });
});
