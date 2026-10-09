import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { registerAllVerbs } from "../src/verbs/index";
import { buildContext } from "../src/auth/context";
import { checkAccess } from "../src/verbs/dispatch";
import { getVerb } from "../src/verbs/table";
import { RESPONSE_RECIPIENT_PREFIX, setResponseRecipients } from "../src/mail/responseRecipients";
import { createProject } from "../src/db/projects";
import { deleteTenant } from "../src/db/tenantDelete";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const host = "respond.pimwell.test", address = "respond@pimwell.test";
beforeAll(registerAllVerbs);
async function world() {
  const tenant = await seedTenant("respond"), foreign = await seedTenant("foreign");
  const human = async (email: string, role: "admin" | "member" | "reader") => {
    const h = await seedHuman(email, { memberships: [{ tenant_id: tenant.id, role }] });
    return { ...h, headers: cookieHeaders(h.token, host) };
  };
  const admin = await human("admin@example.com", "admin"), member = await human("member@example.com", "member"), reader = await human("reader@example.com", "reader");
  const outsider = await seedHuman("outside@example.com", { memberships: [{ tenant_id: foreign.id, role: "member" }] });
  const bot = await seedAgent(tenant, admin.identity);
  const project = await createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug: "site", display_name: "Site", kind: "tracker" }, Date.now());
  return { tenant, foreign, admin, member, reader, outsider, bot, project,
    key: `${RESPONSE_RECIPIENT_PREFIX}${tenant.id}:org` };
}
async function read(w: Awaited<ReturnType<typeof world>>, addr = address) {
  const r = await apiPost(host, "mail.response_recipients", { address: addr }, w.admin.headers);
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json() as { result: Record<string, any> }).result;
}
async function set(w: Awaited<ReturnType<typeof world>>, ids: string[], rev: number, addr = address) {
  return apiPost(host, "mail.set_response_recipients", { address: addr, recipients: ids, expected_revision: rev }, w.admin.headers);
}
async function auditCount() {
  return (await env.HUB_DB.prepare("SELECT COUNT(*) n FROM event WHERE kind = 'mail.set_response_recipients'").first<{ n: number }>())!.n;
}

describe("explicit shared-mailbox response preferences (not scheduling)", () => {
  it("starts unset, configures, reads and explicitly clears without effects", async () => {
    const w = await world();
    const before = await env.HUB_DB.prepare("SELECT COUNT(*) n FROM membership").first();
    expect(await read(w)).toMatchObject({ state: "unset", revision: 0, recipients: [], automatic_scheduling: "not_implemented", response_guaranteed: false });
    expect((await set(w, [w.member.identity.id, w.admin.identity.id], 0)).status).toBe(200);
    expect(await read(w, " RESPOND@PIMWELL.TEST ")).toMatchObject({ state: "configured", revision: 1, recipients: [w.member.identity.id, w.admin.identity.id], unavailable_count: 0, response_guaranteed: false });
    expect((await set(w, [], 1)).status).toBe(200);
    expect(await read(w)).toMatchObject({ state: "empty", revision: 2, recipients: [] });
    expect(await auditCount()).toBe(2);
    for (const table of ["consent", "inbound_mail", "outbound_mail", "attention"]) {
      expect((await env.HUB_DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{ n: number }>())!.n).toBe(0);
    }
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM membership").first()).toEqual(before);
    expect((await env.HUB_DB.prepare("SELECT key FROM meta WHERE key <> 'schema_version'").all()).results.map(r => r.key)).toEqual([w.key]);
  });
  it("keeps org and project settings independent, rejects other tenant/direct-agent/missing addresses", async () => {
    const w = await world();
    expect((await set(w, [w.member.identity.id], 0)).status).toBe(200);
    expect(await read(w, "respond.site@pimwell.test")).toMatchObject({ state: "unset", revision: 0 });
    expect((await set(w, [w.admin.identity.id], 0, "respond.site@pimwell.test")).status).toBe(200);
    expect((await read(w)).recipients).toEqual([w.member.identity.id]);
    for (const addr of ["foreign@pimwell.test", w.bot.agent.identity.email, "respond.missing@pimwell.test", "respond@evil.test", "missing@pimwell.test"]) {
      expect((await apiPost(host, "mail.response_recipients", { address: addr }, w.admin.headers)).status).toBe(404);
      expect((await set(w, [], 0, addr)).status).toBe(404);
    }
    expect(await auditCount()).toBe(2);
  });
  it.each(["outside", "reader", "agent", "removed", "inactive"])("refuses %s recipients without storing/auditing them", async kind => {
    const w = await world();
    let id = w.member.identity.id;
    if (kind === "outside") id = w.outsider.identity.id;
    if (kind === "reader") id = w.reader.identity.id;
    if (kind === "agent") id = w.bot.agent.identity.id;
    if (kind === "removed") await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ?").bind(id).run();
    if (kind === "inactive") await env.HUB_DB.prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(id).run();
    const res = await set(w, [w.admin.identity.id, id], 0);
    expect(res.status).toBe(409);
    expect(await read(w)).toMatchObject({ state: "unset", revision: 0 });
    expect(await auditCount()).toBe(0);
    expect(await res.text()).not.toContain(id);
  });
  it("requires human admin/current proof and origin; never exposes management to assistants", async () => {
    const w = await world();
    for (const headers of [{}, w.member.headers, w.reader.headers, bearer(w.bot.token), { cookie: w.admin.headers.cookie!, origin: "https://evil.test" }]) {
      expect((await apiPost(host, "mail.set_response_recipients", { address, recipients: [], expected_revision: 0 }, headers)).status).not.toBe(200);
    }
    const ctx = await buildContext(new Request(`https://${host}/api/mail.response_recipients`, { headers: bearer(w.bot.token) }), env);
    for (const name of ["mail.response_recipients", "mail.set_response_recipients"]) {
      const verb = getVerb(name)!;
      expect(() => checkAccess({ ...ctx, role: "admin" }, verb)).toThrow("agents may not");
      expect(verb.mcp).toBeUndefined();
    }
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, w.admin.session.id).run();
    expect((await set(w, [], 0)).status).toBe(403);
    expect(await read(w)).toMatchObject({ state: "unset" });
    expect(await auditCount()).toBe(0);
  });
  it.each([undefined, null, -1, 1.2, Number.MAX_SAFE_INTEGER, "bad"])("refuses invalid/missing revision %s", async revision => {
    const w = await world();
    expect((await apiPost(host, "mail.set_response_recipients", { address, recipients: [], expected_revision: revision }, w.admin.headers)).status).toBe(400);
    expect(await auditCount()).toBe(0);
  });
  it.each([null, "", {}, ["bad"], Array(11).fill("01M4AF980SG4A68Q7VNA21WX92")])("refuses invalid recipient arrays %j", async recipients => {
    const w = await world();
    expect((await apiPost(host, "mail.set_response_recipients", { address, recipients, expected_revision: 0 }, w.admin.headers)).status).toBe(400);
    expect(await auditCount()).toBe(0);
  });
  it("rejects duplicates and stale/repeated edits rather than replaying effects", async () => {
    const w = await world();
    expect((await set(w, [w.member.identity.id, w.member.identity.id], 0)).status).toBe(400);
    expect((await set(w, [w.member.identity.id], 0)).status).toBe(200);
    expect((await set(w, [w.member.identity.id], 0)).status).toBe(409);
    expect((await set(w, [], 0)).status).toBe(409);
    expect(await auditCount()).toBe(1);
  });
  it.each([0, 1])("serializes concurrent CAS at revision %s with one committed audit", async revision => {
    const w = await world();
    if (revision) expect((await set(w, [], 0)).status).toBe(200);
    const responses = await Promise.all([set(w, [w.member.identity.id], revision), set(w, [w.admin.identity.id], revision)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const current = await read(w);
    expect(current.revision).toBe(revision + 1);
    expect(current.recipients.length).toBe(1);
    expect(await auditCount()).toBe(revision + 1);
  });
  it.each(["removed", "reader", "inactive", "foreign"])("re-evaluates %s eligibility on reads without leaking stale ids", async change => {
    const w = await world();
    expect((await set(w, [w.member.identity.id, w.admin.identity.id], 0)).status).toBe(200);
    if (change === "removed") await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ?").bind(w.member.identity.id).run();
    if (change === "reader") await env.HUB_DB.prepare("UPDATE membership SET role = 'reader' WHERE identity_id = ?").bind(w.member.identity.id).run();
    if (change === "inactive") await env.HUB_DB.prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(w.member.identity.id).run();
    if (change === "foreign") await env.HUB_DB.prepare("UPDATE membership SET tenant_id = ? WHERE identity_id = ?").bind(w.foreign.id, w.member.identity.id).run();
    expect(await read(w)).toMatchObject({ state: "stale", revision: 1, unavailable_count: 1, recipients: [w.admin.identity.id], response_guaranteed: false });
    expect(await auditCount()).toBe(1);
  });
  it.each(["member", "actor", "project", "tenant"])("rechecks %s authority/eligibility inside the atomic write", async race => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_recipients`, { headers: w.admin.headers }), env);
    const original = ctx.db.batch.bind(ctx.db);
    ctx.db = new Proxy(ctx.db, { get(db, key) {
      if (key !== "batch") { const v = Reflect.get(db, key); return typeof v === "function" ? v.bind(db) : v; }
      return async (stmts: D1PreparedStatement[]) => {
        if (race === "member" || race === "actor") await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ?").bind(race === "member" ? w.member.identity.id : w.admin.identity.id).run();
        if (race === "project") await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.project.id).run();
        if (race === "tenant") await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(w.tenant.id).run();
        return original(stmts);
      };
    } });
    await expect(setResponseRecipients(ctx, race === "project" ? "respond.site@pimwell.test" : address, [w.member.identity.id], 0)).rejects.toThrow("eligibility changed");
    expect(await auditCount()).toBe(0);
    expect((await env.HUB_DB.prepare("SELECT key FROM meta WHERE key <> 'schema_version'").all()).results).toEqual([]);
  });
  it.each(["not-json", "null", "{}", '{"revision":1,"recipients":["foreign-secret-id"]}'])("fails closed on corrupt preferences %s", async value => {
    const w = await world();
    await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").bind(w.key, value).run();
    expect(await read(w)).toMatchObject({ state: "invalid", revision: null, recipients: [], response_guaranteed: false });
    expect((await set(w, [], 0)).status).toBe(409);
    expect(await auditCount()).toBe(0);
  });
  it("rolls back configuration if its audit fails", async () => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_recipients`, { headers: w.admin.headers }), env);
    ctx.session = { ...ctx.session!, id: "missing-session" };
    await expect(setResponseRecipients(ctx, address, [w.member.identity.id], 0)).rejects.toThrow();
    expect(await read(w)).toMatchObject({ state: "unset" });
    expect(await auditCount()).toBe(0);
  });
  it("scopes cleanup to the deleted tenant, preserving unrelated settings", async () => {
    const w = await world();
    expect((await set(w, [w.member.identity.id], 0)).status).toBe(200);
    const keep = `${RESPONSE_RECIPIENT_PREFIX}${w.foreign.id}:org`;
    await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, 'keep')").bind(keep).run();
    await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(w.tenant.id).run();
    await deleteTenant(env.HUB_DB, "respond", w.admin.identity.id, Date.now());
    expect((await env.HUB_DB.prepare("SELECT key, value FROM meta WHERE key <> 'schema_version'").all()).results).toEqual([{ key: keep, value: "keep" }]);
  });
});
