import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { claimWork, createWork, getWork, LEASE_MS, updateWork, type WorkItem } from "../src/db/work";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
const NOW = 1_800_000_000_000;

async function world() {
  const tenant = await seedTenant("acme");
  const project = await createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug: "site", kind: "tracker", display_name: "Site" }, NOW);
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const item = await createWork(env.HUB_DB, { tenant_id: tenant.id, project_id: project.id, kind: "snag", title: "Original", body: "Original details", created_by: pat.identity.id }, NOW);
  const read = async () => (await getWork(env.HUB_DB, tenant.id, item.id))!;
  const call = (verb: string, input: unknown, token = pat.token) => apiPost(HOST, verb, input, cookieHeaders(token, HOST));
  return { tenant, project, pat, sam, item, read, call };
}

const conflict = (operation: Promise<unknown>) => expect(operation).rejects.toMatchObject({ status: 409 });

describe("atomic work snapshot conflicts", () => {
  it.each(["done", "dropped"] as const)("a stale claim cannot reopen %s or change its close time", async (state) => {
    const w = await world();
    const closed = await updateWork(env.HUB_DB, w.item, { state }, NOW + 10);
    await conflict(claimWork(env.HUB_DB, w.item, w.pat.identity.id, NOW + 20));
    expect(await w.read()).toEqual(closed);
    await conflict(claimWork(env.HUB_DB, closed, w.pat.identity.id, NOW + 20));
  });

  it("a stale details update cannot restore the old state after closing", async () => {
    const w = await world();
    const closed = await updateWork(env.HUB_DB, w.item, { state: "done" }, NOW + 10);
    await conflict(updateWork(env.HUB_DB, w.item, { title: "Stale edit" }, NOW + 20));
    expect(await w.read()).toEqual(closed);
    // Reopening is allowed only from the current closed snapshot, explicitly.
    const reopened = await updateWork(env.HUB_DB, closed, { state: "open" }, NOW + 30);
    expect(reopened).toMatchObject({ state: "open", closed_at: null, lease_until: null });
  });

  it("elects one writer for concurrent edits of the same snapshot, even in the same millisecond", async () => {
    const w = await world();
    const outcomes = await Promise.allSettled([
      updateWork(env.HUB_DB, w.item, { title: "First" }, NOW),
      updateWork(env.HUB_DB, w.item, { body: "Second" }, NOW),
    ]);
    const success = outcomes.filter((r) => r.status === "fulfilled");
    expect(success).toHaveLength(1);
    expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await w.read()).toEqual((success[0] as PromiseFulfilledResult<WorkItem>).value);
    expect((await w.read()).updated_at).toBe(NOW + 1);
  });

  it("advances a revision for a no-op edit and refuses an ABA stale snapshot", async () => {
    const w = await world();
    const edited = await updateWork(env.HUB_DB, w.item, { title: "Temporary" }, NOW);
    const restored = await updateWork(env.HUB_DB, edited, { title: "Original" }, NOW);
    const noOp = await updateWork(env.HUB_DB, restored, {}, NOW - 10);
    expect(noOp.updated_at).toBe(NOW + 3);
    await conflict(updateWork(env.HUB_DB, w.item, { body: "Stale" }, NOW + 20));
    expect(await w.read()).toEqual(noOp);
  });

  it.each([
    ["title", "New title"], ["body", "New body"], ["kind", "wish"], ["state", "doing"],
    ["owner_id", "pat"], ["parent_id", "parent"], ["lease_until", NOW + 123], ["closed_at", NOW + 100],
  ])("detects concurrent %s changes even without an updated_at change", async (field, rawValue) => {
    const w = await world();
    const parent = await createWork(env.HUB_DB, { tenant_id: w.tenant.id, project_id: w.project.id, kind: "quest", title: "Parent", body: "", created_by: w.pat.identity.id }, NOW);
    const value = rawValue === "pat" ? w.pat.identity.id : rawValue === "parent" ? parent.id : rawValue;
    await env.HUB_DB.prepare(`UPDATE work_item SET ${field} = ? WHERE id = ?`).bind(value, w.item.id).run();
    const changed = await w.read();
    await conflict(updateWork(env.HUB_DB, w.item, { title: "Stale" }, NOW + 10));
    await conflict(claimWork(env.HUB_DB, w.item, w.sam.identity.id, NOW + 10));
    expect(await w.read()).toEqual(changed);
  });

  it("elects one owner on concurrent claims of the same snapshot", async () => {
    const w = await world();
    const outcomes = await Promise.allSettled([
      claimWork(env.HUB_DB, w.item, w.pat.identity.id, NOW),
      claimWork(env.HUB_DB, w.item, w.sam.identity.id, NOW),
    ]);
    const success = outcomes.filter((r) => r.status === "fulfilled");
    expect(success).toHaveLength(1);
    expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await w.read()).toEqual((success[0] as PromiseFulfilledResult<WorkItem>).value);
  });

  it("a stale expired lease cannot overwrite a renewed owner lease", async () => {
    const w = await world();
    const claimed = await claimWork(env.HUB_DB, w.item, w.pat.identity.id, NOW);
    const renewed = await claimWork(env.HUB_DB, claimed, w.pat.identity.id, NOW + LEASE_MS + 1);
    await conflict(claimWork(env.HUB_DB, claimed, w.sam.identity.id, NOW + LEASE_MS + 2));
    expect(await w.read()).toEqual(renewed);
    await conflict(claimWork(env.HUB_DB, renewed, w.sam.identity.id, NOW + LEASE_MS + 3));
    const takeover = await claimWork(env.HUB_DB, renewed, w.sam.identity.id, renewed.lease_until! + 1);
    expect(takeover.owner_id).toBe(w.sam.identity.id);
    expect(await w.read()).toEqual(takeover);
  });

  it("clears an old lease on reassignment and does not resurrect ownership removed without a timestamp", async () => {
    const w = await world();
    const claimed = await claimWork(env.HUB_DB, w.item, w.pat.identity.id, NOW);
    await env.HUB_DB.prepare("UPDATE work_item SET owner_id = NULL, lease_until = NULL WHERE id = ?").bind(w.item.id).run();
    await conflict(updateWork(env.HUB_DB, claimed, { body: "Stale" }, NOW + 1));
    const unassigned = await w.read();
    const mine = await claimWork(env.HUB_DB, unassigned, w.pat.identity.id, NOW + 2);
    const assigned = await updateWork(env.HUB_DB, mine, { owner_id: w.sam.identity.id }, NOW + 3);
    expect(assigned).toMatchObject({ state: "doing", owner_id: w.sam.identity.id, lease_until: null });
    const theirs = await claimWork(env.HUB_DB, assigned, w.sam.identity.id, NOW + 4);
    expect(theirs.lease_until).toBe(NOW + 4 + LEASE_MS);
    const closed = await updateWork(env.HUB_DB, theirs, { state: "done" }, NOW + 5);
    expect(closed).toMatchObject({ state: "done", closed_at: NOW + 5, lease_until: null });
    const detailEdit = await updateWork(env.HUB_DB, closed, { title: "  Trimmed  " }, NOW + 6);
    expect(detailEdit).toMatchObject({ title: "Trimmed", closed_at: NOW + 5, lease_until: null });
    expect(await w.read()).toEqual(detailEdit);
  });

  it.each(["tenant_id", "project_id"] as const)("refuses a snapshot with another %s without altering the row", async (field) => {
    const w = await world();
    const wrong = { ...w.item, [field]: "unrelated-scope" };
    await conflict(updateWork(env.HUB_DB, wrong, { title: "Wrong scope" }, NOW + 1));
    await conflict(claimWork(env.HUB_DB, wrong, w.sam.identity.id, NOW + 1));
    expect(await w.read()).toEqual(w.item);
  });

  it("refuses a vanished row instead of fabricating a successful result", async () => {
    const w = await world();
    // Fixture only: no actual application data is deleted.
    await env.HUB_DB.prepare("DELETE FROM work_item WHERE id = ?").bind(w.item.id).run();
    await conflict(updateWork(env.HUB_DB, w.item, { title: "Vanished" }, NOW + 1));
    await conflict(claimWork(env.HUB_DB, w.item, w.pat.identity.id, NOW + 1));
  });
});

describe("work command conflict side effects", () => {
  it.each(["work.claim", "work.update"])("%s accepts the current optional revision and refuses a stale client revision", async (verb) => {
    const w = await world();
    const input = { id: w.item.id, expected_updated_at: w.item.updated_at, ...(verb === "work.update" ? { title: "Current edit" } : {}) };
    const accepted = await w.call(verb, input);
    expect(accepted.status).toBe(200);
    const current = await w.read();
    expect(current.updated_at).toBeGreaterThan(w.item.updated_at);
    const events = (await env.HUB_DB.prepare("SELECT * FROM event").all()).results;
    const attention = (await env.HUB_DB.prepare("SELECT * FROM attention").all()).results;
    expect((await w.call(verb, input)).status).toBe(409);
    expect(await w.read()).toEqual(current);
    expect((await env.HUB_DB.prepare("SELECT * FROM event").all()).results).toEqual(events);
    expect((await env.HUB_DB.prepare("SELECT * FROM attention").all()).results).toEqual(attention);
    expect((await w.call(verb, { ...input, expected_updated_at: current.updated_at })).status).toBe(200);
  });

  it.each([-1, 1.5, "not-a-revision", true, Number.MAX_SAFE_INTEGER + 1])("rejects malformed client revision %j", async (expected_updated_at) => {
    const w = await world();
    for (const verb of ["work.claim", "work.update"]) {
      expect((await w.call(verb, { id: w.item.id, expected_updated_at, title: "Invalid" })).status).toBe(400);
    }
    expect(await w.read()).toEqual(w.item);
  });

  it("does not expose cross-tenant item revisions through conditional commands", async () => {
    const w = await world();
    const other = await seedTenant("bravo");
    const eve = await seedHuman("eve@example.com", { memberships: [{ tenant_id: other.id, role: "member" }] });
    for (const verb of ["work.claim", "work.update"]) {
      const response = await apiPost("bravo.pimwell.test", verb, { id: w.item.id, expected_updated_at: 0, title: "Other tenant" }, cookieHeaders(eve.token, "bravo.pimwell.test"));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("Original");
    }
    expect(await w.read()).toEqual(w.item);
  });

  it.each(["work.claim", "work.update"])("stops %s before audit, following and attention on a rejected write", async (verb) => {
    const w = await world();
    // Native D1 fixture makes the mutation lose at the actual write boundary.
    await env.HUB_DB.exec("CREATE TRIGGER reject_work_write BEFORE UPDATE ON work_item BEGIN SELECT RAISE(IGNORE); END;");
    try {
      const response = await w.call(verb, { id: w.item.id, ...(verb === "work.update" ? { title: "Rejected", owner: "sam@example.com" } : {}) });
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await env.HUB_DB.prepare("SELECT COUNT(*) FROM event WHERE kind IN ('work.claim', 'work.update')").first("COUNT(*)")).toBe(0);
      expect(await env.HUB_DB.prepare("SELECT COUNT(*) FROM attention").first("COUNT(*)")).toBe(0);
      expect(await env.HUB_DB.prepare("SELECT COUNT(*) FROM follow").first("COUNT(*)")).toBe(0);
      expect(await w.read()).toEqual(w.item);
    } finally {
      await env.HUB_DB.exec("DROP TRIGGER reject_work_write;");
    }
    expect((await w.call(verb, { id: w.item.id, ...(verb === "work.update" ? { title: "Accepted" } : {}) })).status).toBe(200);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) FROM event WHERE kind = ?").bind(verb).first("COUNT(*)")).toBe(1);
  });
});
