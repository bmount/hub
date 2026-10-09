import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

async function world() {
  const tenant = await seedTenant("acme");
  const project = await createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug: "site", kind: "tracker", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const call = async (verb: string, body: unknown, token = pat.token, host = HOST) => {
    const response = await apiPost(host, verb, body, cookieHeaders(token, host));
    return { status: response.status, body: await response.json() as { result: any } };
  };
  const created = await call("work.create", { project: "site", kind: "snag", title: "Creation audit" });
  return { tenant, project, pat, sam, call, item: created.body.result.item };
}

async function events(kind: string) {
  return (await env.HUB_DB.prepare("SELECT * FROM event WHERE kind = ? ORDER BY id").bind(kind).all()).results;
}

async function links() {
  return (await env.HUB_DB.prepare("SELECT * FROM work_link").all()).results;
}

async function deploys() {
  return (await env.HUB_DB.prepare("SELECT * FROM app_deploy").all()).results;
}

const linkInput = (id: string, extra = {}) => ({ id, target_kind: "url", target_ref: "https://example.com/evidence", note: "Original evidence", ...extra });
const deployInput = (extra = {}) => ({ project: "site", commit: COMMIT, message: "Original rollout", ...extra });

describe("creation-only work link audit", () => {
  it("returns the persisted canonical link on retries without touching the item or replacing authorship/note/time", async () => {
    const w = await world();
    await env.HUB_DB.prepare("UPDATE work_item SET updated_at = 1234 WHERE id = ?").bind(w.item.id).run();
    const first = await w.call("work.link", linkInput(w.item.id, { target_ref: "HTTPS://EXAMPLE.COM:443/evidence" }));
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({ created: true, ref: "site#1", link: { target_ref: "https://example.com/evidence", created_by: w.pat.identity.id } });
    expect(await env.HUB_DB.prepare("SELECT updated_at FROM work_item WHERE id = ?").bind(w.item.id).first("updated_at")).toBe(first.body.result.link.created_at);
    const originalEvents = await events("work.link");
    expect(originalEvents).toHaveLength(1);
    expect(originalEvents[0]).toMatchObject({ identity_id: w.pat.identity.id, session_id: w.pat.session.id, target_id: w.item.id, summary: "Linked site#1 to url https://example.com/evidence" });
    // A duplicate must not touch a later unrelated item edit, even from another member.
    await env.HUB_DB.prepare("UPDATE work_item SET updated_at = 1234 WHERE id = ?").bind(w.item.id).run();
    for (let i = 0; i < 3; i++) {
      const retry = await w.call("work.link", linkInput(w.item.id, { note: "Do not replace" }), w.sam.token);
      expect(retry.status).toBe(200);
      expect(retry.body.result).toEqual({ ...first.body.result, created: false });
    }
    expect(await links()).toEqual([first.body.result.link]);
    expect(await events("work.link")).toEqual(originalEvents);
    expect(await env.HUB_DB.prepare("SELECT updated_at FROM work_item WHERE id = ?").bind(w.item.id).first("updated_at")).toBe(1234);
  });

  it("elects one concurrent creator and gives every caller the same persisted link", async () => {
    const w = await world();
    const calls = await Promise.all(Array.from({ length: 6 }, (_, i) => w.call("work.link", linkInput(w.item.id, { note: `Attempt ${i}` }), i % 2 ? w.sam.token : w.pat.token)));
    expect(calls.map(c => c.status)).toEqual(Array(6).fill(200));
    expect(calls.filter(c => c.body.result.created)).toHaveLength(1);
    const winner = calls.find(c => c.body.result.created)!.body.result.link;
    for (const call of calls) expect(call.body.result.link).toEqual(winner);
    expect(await links()).toEqual([winner]);
    expect(await events("work.link")).toHaveLength(1);
    expect((await events("work.link"))[0]).toMatchObject({ identity_id: winner.created_by });
  });

  it("keeps distinct kinds/items independent and refuses unsafe duplicate authority", async () => {
    const w = await world();
    expect((await w.call("work.link", linkInput(w.item.id))).body.result.created).toBe(true);
    expect((await w.call("work.link", linkInput(w.item.id, { target_kind: "commit" }))).body.result.created).toBe(true);
    const second = await w.call("work.create", { project: "site", kind: "snag", title: "Second" });
    expect((await w.call("work.link", linkInput(second.body.result.item.id))).body.result.created).toBe(true);
    expect((await w.call("work.link", linkInput(w.item.id, { target_ref: "javascript:alert(1)" }))).status).toBe(400);
    expect(await links()).toHaveLength(3);
    expect(await events("work.link")).toHaveLength(3);
  });

  it("still checks current membership and tenant on duplicate requests", async () => {
    const w = await world();
    await w.call("work.link", linkInput(w.item.id));
    await env.HUB_DB.prepare("UPDATE membership SET role = 'reader' WHERE tenant_id = ? AND identity_id = ?").bind(w.tenant.id, w.sam.identity.id).run();
    expect((await w.call("work.link", linkInput(w.item.id), w.sam.token)).status).toBe(403);
    const other = await seedTenant("bravo");
    const eve = await seedHuman("eve@example.com", { memberships: [{ tenant_id: other.id, role: "member" }] });
    expect((await w.call("work.link", linkInput(w.item.id), eve.token, "bravo.pimwell.test")).status).toBe(404);
    expect(await links()).toHaveLength(1);
    expect(await events("work.link")).toHaveLength(1);
  });
});

describe("creation-only deploy audit", () => {
  it("returns the original deploy on retries without changing metadata or creating new Deployed events", async () => {
    const w = await world();
    const first = await w.call("deploy.record", deployInput());
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({ project: "site", commit: COMMIT, environment: "production", created: true, deploy: { tenant_id: w.tenant.id, project_id: w.project.id, script_name: "site:production", message: "Original rollout" } });
    const originalEvents = await events("deploy.record");
    expect(originalEvents).toHaveLength(1);
    expect(originalEvents[0]).toMatchObject({ identity_id: w.pat.identity.id, session_id: w.pat.session.id, target_id: w.project.id, summary: `Deployed site ${COMMIT.slice(0, 12)} to production: Original rollout` });
    for (let i = 0; i < 3; i++) {
      const retry = await w.call("deploy.record", deployInput({ environment: "PRODUCTION", message: "Do not replace" }), w.sam.token);
      expect(retry.status).toBe(200);
      expect(retry.body.result).toEqual({ ...first.body.result, created: false });
    }
    expect(await deploys()).toEqual([first.body.result.deploy]);
    expect(await events("deploy.record")).toEqual(originalEvents);
  });

  it("elects one concurrent creator and returns its original metadata to all callers", async () => {
    const w = await world();
    const calls = await Promise.all(Array.from({ length: 6 }, (_, i) => w.call("deploy.record", deployInput({ message: `Attempt ${i}` }), i % 2 ? w.sam.token : w.pat.token)));
    expect(calls.map(c => c.status)).toEqual(Array(6).fill(200));
    expect(calls.filter(c => c.body.result.created)).toHaveLength(1);
    const winner = calls.find(c => c.body.result.created)!;
    for (const call of calls) expect(call.body.result.deploy).toEqual(winner.body.result.deploy);
    expect(await deploys()).toEqual([winner.body.result.deploy]);
    expect(await events("deploy.record")).toHaveLength(1);
    expect((await events("deploy.record"))[0]!.summary).toContain(winner.body.result.deploy.message);
  });

  it("keeps environments, projects and commits independent", async () => {
    const w = await world();
    await createProject(env.HUB_DB, { tenant_id: w.tenant.id, namespace_id: null, slug: "other", kind: "tracker", display_name: "Other" }, Date.now());
    for (const input of [deployInput(), deployInput({ environment: "staging" }), deployInput({ project: "other" }), deployInput({ commit: "abcdef0" })]) {
      expect((await w.call("deploy.record", input)).body.result.created).toBe(true);
    }
    expect(await deploys()).toHaveLength(4);
    expect(await events("deploy.record")).toHaveLength(4);
  });

  it("refuses the legacy global-key tenant collision without exposing another tenant's deploy", async () => {
    const w = await world();
    await w.call("deploy.record", deployInput({ message: "Private original metadata" }));
    const other = await seedTenant("bravo");
    await createProject(env.HUB_DB, { tenant_id: other.id, namespace_id: null, slug: "site", kind: "tracker", display_name: "Other Site" }, Date.now());
    const eve = await seedHuman("eve@example.com", { memberships: [{ tenant_id: other.id, role: "member" }] });
    const collision = await w.call("deploy.record", deployInput(), eve.token, "bravo.pimwell.test");
    expect(collision.status).toBe(409);
    expect(JSON.stringify(collision.body)).not.toContain("Private original metadata");
    expect(await deploys()).toHaveLength(1);
    expect(await events("deploy.record")).toHaveLength(1);
    expect((await w.call("deploy.list", {}, eve.token, "bravo.pimwell.test")).body.result.deploys).toEqual([]);
  });

  it("checks current membership and active project before replaying a deploy", async () => {
    const w = await world();
    await w.call("deploy.record", deployInput());
    await env.HUB_DB.prepare("UPDATE membership SET role = 'reader' WHERE tenant_id = ? AND identity_id = ?").bind(w.tenant.id, w.sam.identity.id).run();
    expect((await w.call("deploy.record", deployInput(), w.sam.token)).status).toBe(403);
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.project.id).run();
    expect((await w.call("deploy.record", deployInput())).status).toBe(404);
    expect(await events("deploy.record")).toHaveLength(1);
  });
});

describe("atomic creation audit", () => {
  it.each(["work.link", "deploy.record"])("rolls back %s creation and item touch on audit failure, then allows one reconciled retry", async (kind) => {
    const w = await world();
    const input = kind === "work.link" ? linkInput(w.item.id) : deployInput();
    const before = await env.HUB_DB.prepare("SELECT updated_at FROM work_item WHERE id = ?").bind(w.item.id).first("updated_at");
    await env.HUB_DB.exec(`CREATE TRIGGER fail_creation_audit BEFORE INSERT ON event WHEN NEW.kind = '${kind}' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END;`);
    try {
      expect((await w.call(kind, input)).status).toBe(500);
      expect(await links()).toHaveLength(0);
      expect(await deploys()).toHaveLength(0);
      expect(await events(kind)).toHaveLength(0);
      expect(await env.HUB_DB.prepare("SELECT updated_at FROM work_item WHERE id = ?").bind(w.item.id).first("updated_at")).toBe(before);
    } finally {
      await env.HUB_DB.exec("DROP TRIGGER fail_creation_audit;");
    }
    const first = await w.call(kind, input);
    expect(first.status).toBe(200);
    expect(first.body.result.created).toBe(true);
    const retry = await w.call(kind, input);
    expect(retry.status).toBe(200);
    expect(retry.body.result).toEqual({ ...first.body.result, created: false });
    expect(await events(kind)).toHaveLength(1);
  });
});
