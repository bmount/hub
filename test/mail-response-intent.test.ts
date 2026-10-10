import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import fixtures from "./fixtures/dkim.json";
import { registerAllVerbs } from "../src/verbs/index";
import { getVerb } from "../src/verbs/table";
import { checkAccess } from "../src/verbs/dispatch";
import { buildContext } from "../src/auth/context";
import { storeIndependentMailCandidate, REPLAY_PREFIX } from "../src/mail/replay";
import { RESPONSE_RECIPIENT_PREFIX } from "../src/mail/responseRecipients";
import { RESPONSE_INTENT_PREFIX, responseIntent, setResponseIntent } from "../src/mail/responseIntent";
import { REPLY_WINDOW_MS } from "../src/mail/limits";
import { mailSetResponseIntent } from "../src/verbs/mailIntent";
import { createProject } from "../src/db/projects";
import { deleteTenant } from "../src/db/tenantDelete";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const host = "intent.pimwell.test", address = "intent@pimwell.test";
const now = Date.parse(fixtures.now) + 120_000;
beforeAll(registerAllVerbs);
async function world(projectMail = false) {
  const tenant = await seedTenant("intent"), foreign = await seedTenant("foreign");
  const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: tenant.id, role: "admin" }] });
  const member = await seedHuman("member@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const other = await seedHuman("other@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: tenant.id, role: "reader" }] });
  const bot = await seedAgent(tenant, admin.identity);
  const project = await createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug: "site", display_name: "Site", kind: "tracker" }, Date.now());
  const to = projectMail ? "intent.site@pimwell.test" : address;
  const stored = await storeIndependentMailCandidate(env, { bytes: new TextEncoder().encode(fixtures.valid), from: member.identity.email, to }, now, async () => [[fixtures.record]]);
  if (stored.status !== "stored") throw new Error("signed fixture was not stored");
  const adminHeaders = cookieHeaders(admin.token, host), headers = cookieHeaders(member.token, host);
  expect((await apiPost(host, "mail.set_response_recipients", { address: to, recipients: [member.identity.id, other.identity.id], expected_revision: 0 }, adminHeaders)).status).toBe(200);
  return { tenant, foreign, admin, member, other, reader, bot, project, to, id: stored.mail_id, headers, adminHeaders, requestHost: host,
    intentKey: `${RESPONSE_INTENT_PREFIX}${tenant.id}:${stored.mail_id}:${member.identity.id}`,
    prefKey: `${RESPONSE_RECIPIENT_PREFIX}${tenant.id}:${projectMail ? project.id : "org"}` };
}
async function read(w: Awaited<ReturnType<typeof world>>, headers = w.headers) {
  const r = await apiPost(w.requestHost, "mail.response_intent", { id: w.id }, headers);
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json() as { result: Record<string, any> }).result;
}
const set = (w: Awaited<ReturnType<typeof world>>, state = "planned", rev = 0, headers = w.headers) =>
  apiPost(w.requestHost, "mail.set_response_intent", { id: w.id, state, expected_revision: rev }, headers);
const count = async () => env.HUB_DB.prepare("SELECT COUNT(*) n FROM event WHERE kind = 'mail.set_response_intent'").first<number>("n");

describe("explicit self-recorded human response intent, not automatic scheduling", () => {
  it.each([false, true])("records/cancels/replans org/project=%s intent without any delivery, grant, consent or mail mutation", async project => {
    const w = await world(project);
    const mail = await env.HUB_DB.prepare("SELECT * FROM inbound_mail").all();
    const members = await env.HUB_DB.prepare("SELECT * FROM membership").all();
    expect(await read(w)).toMatchObject({ state: "unset", revision: 0, can_plan: true, automatic_execution: "not_implemented", response_guaranteed: false });
    expect((await set(w)).status).toBe(200);
    expect(await read(w)).toMatchObject({ state: "planned", revision: 1, notification: "not_requested", response_guaranteed: false });
    expect((await set(w, "cancelled", 1)).status).toBe(200);
    expect(await read(w)).toMatchObject({ state: "cancelled", revision: 2 });
    expect((await set(w, "planned", 2)).status).toBe(200);
    expect(await count()).toBe(3);
    expect((await env.HUB_DB.prepare("SELECT * FROM inbound_mail").all()).results).toEqual(mail.results);
    expect((await env.HUB_DB.prepare("SELECT * FROM membership").all()).results).toEqual(members.results);
    for (const table of ["outbound_mail", "attention", "consent", "oauth_grant"]) expect(await env.HUB_DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n")).toBe(0);
    expect((await env.HUB_DB.prepare("SELECT key FROM meta WHERE key GLOB 'mail_welcome:*'").all()).results).toEqual([]);
  });
  it("records only the caller's intention, not an admin-selected assignment or another person's status", async () => {
    const w = await world();
    expect((await set(w)).status).toBe(200);
    expect(await read(w, cookieHeaders(w.other.token, host))).toMatchObject({ state: "unset", revision: 0 });
    expect((await set(w, "planned", 0, cookieHeaders(w.other.token, host))).status).toBe(200);
    expect(await read(w)).toMatchObject({ state: "planned", revision: 1 });
    expect(await read(w, w.adminHeaders)).toMatchObject({ state: "unset", can_plan: false });
    expect((await set(w, "planned", 0, w.adminHeaders)).status).toBe(409);
    expect(await count()).toBe(2);
  });
  it.each([0, 1])("CAS serializes first/later concurrent writes at revision %s, requiring read reconciliation", async rev => {
    const w = await world();
    if (rev) expect((await set(w)).status).toBe(200);
    const state = rev ? "cancelled" : "planned";
    expect((await Promise.all([set(w, state, rev), set(w, state, rev)])).map(r => r.status).sort()).toEqual([200, 409]);
    expect((await read(w)).revision).toBe(rev + 1);
    expect(await count()).toBe(rev + 1);
    expect((await set(w, state, rev)).status).toBe(409);
    expect((await set(w, state, rev + 1)).status).toBe(409);
    expect(await count()).toBe(rev + 1);
  });
  it("does not cancel an absent intention or treat preferences as intention", async () => {
    const w = await world();
    expect((await set(w, "cancelled")).status).toBe(409);
    expect(await count()).toBe(0);
    expect(await read(w)).toMatchObject({ state: "unset", revision: 0 });
  });
  it.each(["clear", "corrupt", "rename", "archive"])("observes %s as stale, permits explicit cancellation but refuses replan", async change => {
    const w = await world(change === "archive");
    expect((await set(w)).status).toBe(200);
    if (change === "clear") expect((await apiPost(host, "mail.set_response_recipients", { address: w.to, recipients: [], expected_revision: 1 }, w.adminHeaders)).status).toBe(200);
    if (change === "corrupt") await env.HUB_DB.prepare("UPDATE meta SET value = '{}' WHERE key = ?").bind(w.prefKey).run();
    if (change === "rename") {
      await env.HUB_DB.prepare("UPDATE tenant SET slug = 'renamed' WHERE id = ?").bind(w.tenant.id).run();
      // Tenant-host authority moves with the slug; do not weaken the old-host denial.
      w.requestHost = "renamed.pimwell.test";
      w.headers = cookieHeaders(w.member.token, w.requestHost);
    }
    if (change === "archive") await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.project.id).run();
    expect(await read(w)).toMatchObject({ state: "stale", revision: 1, can_plan: false, response_guaranteed: false });
    expect((await set(w, "cancelled", 1)).status).toBe(200);
    expect((await set(w, "planned", 2)).status).toBe(409);
    expect(await read(w)).toMatchObject({ state: "cancelled", revision: 2 });
  });
  it.each(["quarantine", "released", "reason", "legacy", "pending", "corrupt", "identity", "message", "foreign", "private"])("refuses %s evidence even for the administrator", async change => {
    const w = await world();
    if (change === "quarantine") await env.HUB_DB.prepare("UPDATE inbound_mail SET verdict = 'quarantined' WHERE id = ?").bind(w.id).run();
    if (change === "released") await env.HUB_DB.prepare("UPDATE inbound_mail SET released_by = ? WHERE id = ?").bind(w.admin.identity.id, w.id).run();
    if (change === "reason") await env.HUB_DB.prepare("UPDATE inbound_mail SET reason = 'unknown' WHERE id = ?").bind(w.id).run();
    if (change === "legacy") await env.HUB_DB.prepare("DELETE FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
    if (["pending", "corrupt", "identity"].includes(change)) {
      const replay = (await env.HUB_DB.prepare("SELECT key, value FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").first<{ key: string; value: string }>())!;
      const v = JSON.parse(replay.value); if (change === "pending") v.status = "pending"; if (change === "identity") v.identity_id = w.admin.identity.id;
      await env.HUB_DB.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(change === "corrupt" ? "{}" : JSON.stringify(v), replay.key).run();
    }
    if (change === "message") await env.HUB_DB.prepare("UPDATE inbound_mail SET message_id = '<different@example.com>' WHERE id = ?").bind(w.id).run();
    if (change === "foreign") await env.HUB_DB.prepare("UPDATE inbound_mail SET tenant_id = ? WHERE id = ?").bind(w.foreign.id, w.id).run();
    if (change === "private") await env.HUB_DB.prepare("UPDATE inbound_mail SET recipient_id = ? WHERE id = ?").bind(w.bot.agent.identity.id, w.id).run();
    for (const headers of [w.headers, w.adminHeaders]) {
      expect((await apiPost(host, "mail.response_intent", { id: w.id }, headers)).status).toBe(404);
      expect((await set(w, "planned", 0, headers)).status).toBe(404);
    }
    expect(await count()).toBe(0);
  });
  it("requires active human member/browser proof and Origin; no MCP/assistant execution", async () => {
    const w = await world();
    for (const headers of [{}, cookieHeaders(w.reader.token, host), bearer(w.bot.token), { cookie: w.headers.cookie!, origin: "https://evil.test" }]) expect((await set(w, "planned", 0, headers)).status).not.toBe(200);
    const ctx = await buildContext(new Request(`https://${host}/api/mail.response_intent`, { headers: bearer(w.bot.token) }), env);
    for (const name of ["mail.response_intent", "mail.set_response_intent"]) {
      const verb = getVerb(name)!;
      expect(verb.mcp).toBeUndefined();
      expect(() => checkAccess({ ...ctx, role: "admin" }, verb)).toThrow("agents may not");
    }
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, w.member.session.id).run();
    expect((await set(w)).status).toBe(403);
    expect(await read(w)).toMatchObject({ state: "unset" });
    expect(await count()).toBe(0);
  });
  it.each(["removed", "reader", "archived", "root"])("does not let %s caller authority act as current response eligibility", async change => {
    const w = await world();
    if (change === "removed" || change === "root") await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ?").bind(w.member.identity.id).run();
    if (change === "root") await env.HUB_DB.prepare("UPDATE identity SET is_root = 1 WHERE id = ?").bind(w.member.identity.id).run();
    if (change === "reader") await env.HUB_DB.prepare("UPDATE membership SET role = 'reader' WHERE identity_id = ?").bind(w.member.identity.id).run();
    if (change === "archived") await env.HUB_DB.prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(w.member.identity.id).run();
    expect((await set(w)).status).not.toBe(200);
    expect(await count()).toBe(0);
  });
  it.each(["member", "tenant", "project", "preferences", "proof", "mail"])("rechecks %s inside the atomic intent/audit transaction", async change => {
    const w = await world(true);
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    const original = ctx.db.batch.bind(ctx.db);
    ctx.db = new Proxy(ctx.db, { get(db, key) {
      if (key !== "batch") { const v = Reflect.get(db, key); return typeof v === "function" ? v.bind(db) : v; }
      return async (stmts: D1PreparedStatement[]) => {
        if (change === "member") await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ?").bind(w.member.identity.id).run();
        if (change === "tenant") await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(w.tenant.id).run();
        if (change === "project") await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.project.id).run();
        if (change === "preferences") await env.HUB_DB.prepare("UPDATE meta SET value = '{}' WHERE key = ?").bind(w.prefKey).run();
        if (change === "proof") await env.HUB_DB.prepare("DELETE FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
        if (change === "mail") await env.HUB_DB.prepare("UPDATE inbound_mail SET released_by = ? WHERE id = ?").bind(w.admin.identity.id, w.id).run();
        return original(stmts);
      };
    } });
    await expect(setResponseIntent(ctx, w.id, "planned", 0)).rejects.toThrow("eligibility changed");
    expect(await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(w.intentKey).first()).toBeNull();
    expect(await count()).toBe(0);
  });
  it.each([undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER, "bad"])("rejects missing/invalid revision %s", async rev => {
    const w = await world();
    expect((await apiPost(host, "mail.set_response_intent", { id: w.id, state: "planned", expected_revision: rev }, w.headers)).status).toBe(400);
    expect(await count()).toBe(0);
  });
  it.each(["sent", "unknown", "", null])("rejects unsupported state %s instead of claiming delivery", async state => {
    const w = await world();
    expect((await apiPost(host, "mail.set_response_intent", { id: w.id, state, expected_revision: 0 }, w.headers)).status).toBe(400);
  });
  it.each(["not-json", "{}", '{"revision":1,"state":"sent"}'])("reports corrupt intent %s without resetting it", async value => {
    const w = await world();
    await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").bind(w.intentKey, value).run();
    expect(await read(w)).toMatchObject({ state: "invalid", revision: null, response_guaranteed: false });
    expect((await set(w)).status).toBe(409);
    expect(await count()).toBe(0);
  });
  it("reconciles a lost transaction response by reading, without duplicate audits or blind replay", async () => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    const original = ctx.db.batch.bind(ctx.db);
    ctx.db = new Proxy(ctx.db, { get(db, key) {
      if (key !== "batch") { const v = Reflect.get(db, key); return typeof v === "function" ? v.bind(db) : v; }
      return async (stmts: D1PreparedStatement[]) => { await original(stmts); throw new Error("lost response"); };
    } });
    await expect(setResponseIntent(ctx, w.id, "planned", 0)).rejects.toThrow("lost response");
    expect(await read(w)).toMatchObject({ state: "planned", revision: 1 });
    expect((await set(w)).status).toBe(409);
    expect(await count()).toBe(1);
  });
  it("does not resurrect a previously observed intent deleted before the transaction", async () => {
    const w = await world(); expect((await set(w)).status).toBe(200);
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    const original = ctx.db.batch.bind(ctx.db);
    ctx.db = new Proxy(ctx.db, { get(db, key) {
      if (key !== "batch") { const v = Reflect.get(db, key); return typeof v === "function" ? v.bind(db) : v; }
      return async (stmts: D1PreparedStatement[]) => {
        await env.HUB_DB.prepare("DELETE FROM meta WHERE key = ?").bind(w.intentKey).run(); return original(stmts);
      };
    } });
    await expect(setResponseIntent(ctx, w.id, "cancelled", 1)).rejects.toThrow("eligibility changed");
    expect(await read(w)).toMatchObject({ state: "unset", revision: 0 });
    expect(await count()).toBe(1);
  });
  it("rolls back the intent if audit fails", async () => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    ctx.session = { ...ctx.session!, id: "missing-session" };
    await expect(setResponseIntent(ctx, w.id, "planned", 0)).rejects.toThrow();
    expect(await read(w)).toMatchObject({ state: "unset", revision: 0 });
    expect(await count()).toBe(0);
  });
  it("shows truthful own intention and native revision-checked plan/cancel forms in the mail inspector", async () => {
    const w = await world();
    const page = () => SELF.fetch(`https://${host}/mail/${w.id}`, { headers: w.headers });
    const first = await page();
    expect(first.headers.get("cache-control")).toBe("no-store");
    const html = await first.text();
    expect(html).toContain("My response intention");
    expect(html).toContain("This does not guarantee a reply");
    expect(html).toContain('name="expected_revision" value="0"');
    expect(html).toContain("I intend to respond");
    const key = html.match(/id="inspector"[^>]*data-key="([^"]*)"/)![1];
    const body = new URLSearchParams({ id: w.id, state: "planned", expected_revision: "0", _back: `/mail/${w.id}` });
    const saved = await SELF.fetch(`https://${host}/api/mail.set_response_intent`, { method: "POST", body, headers: w.headers, redirect: "manual" });
    expect(saved.status).toBe(303); expect(saved.headers.get("location")).toBe(`/mail/${w.id}`);
    const current = await (await page()).text();
    expect(current).toContain('name="expected_revision" value="1"');
    expect(current).toContain("Cancel my intention");
    expect(current.match(/id="inspector"[^>]*data-key="([^"]*)"/)![1]).not.toBe(key);
    expect((await SELF.fetch(`https://${host}/api/mail.set_response_intent`, { method: "POST", body, headers: w.headers, redirect: "manual" })).status).toBe(409);
    body.set("state", "cancelled"); body.set("expected_revision", "1");
    expect((await SELF.fetch(`https://${host}/api/mail.set_response_intent`, { method: "POST", body, headers: w.headers, redirect: "manual" })).status).toBe(303);
    expect(await read(w)).toMatchObject({ state: "cancelled", revision: 2 });
  });
  it("renders reproof instead of an intent form; a stale-proof form redirects without a write", async () => {
    const w = await world();
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, w.member.session.id).run();
    const html = await (await SELF.fetch(`https://${host}/mail/${w.id}`, { headers: w.headers })).text();
    expect(html).toContain("recent confirmation");
    expect(html).not.toContain('action="/api/mail.set_response_intent"');
    const body = new URLSearchParams({ id: w.id, state: "planned", expected_revision: "0", _back: `/mail/${w.id}` });
    const r = await SELF.fetch(`https://${host}/api/mail.set_response_intent`, { method: "POST", body, headers: w.headers, redirect: "manual" });
    expect(r.status).toBe(303); expect(r.headers.get("location")).toContain("/login?reproof=1");
    expect(await count()).toBe(0);
  });
  it.each(["reader", "agent", "legacy", "private", "corrupt", "unselected"])("does not render misleading intent controls for %s", async change => {
    const w = await world(); let headers = w.headers;
    if (change === "reader") headers = cookieHeaders(w.reader.token, host);
    if (change === "agent") headers = bearer(w.bot.token);
    if (change === "legacy") await env.HUB_DB.prepare("DELETE FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
    if (change === "private") { await env.HUB_DB.prepare("UPDATE inbound_mail SET recipient_id = ? WHERE id = ?").bind(w.bot.agent.identity.id, w.id).run(); headers = w.adminHeaders; }
    if (change === "corrupt") await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, '{}')").bind(w.intentKey).run();
    if (change === "unselected") headers = w.adminHeaders;
    const r = await SELF.fetch(`https://${host}/mail/${w.id}`, { headers }); expect(r.status).toBe(200);
    const html = await r.text(); expect(html).not.toContain('action="/api/mail.set_response_intent"');
    if (change === "corrupt") expect(html).toContain("Stored intention is invalid");
    if (change === "unselected") expect(html).toContain("Current mailbox preferences do not select you");
    expect(await count()).toBe(0);
  });
  it.each([false, true])("records optional UTC deadline, observes overdue without side effects, and retimes/cancels org/project=%s", async project => {
    const w = await world(project);
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    ctx.now = now + 60_000;
    const due = ctx.now + 60_000;
    expect(await setResponseIntent(ctx, w.id, "planned", 0, due)).toMatchObject({ state: "planned", revision: 1, respond_by: due, automatic_execution: "not_implemented" });
    expect(await responseIntent(ctx, w.id)).toMatchObject({ state: "planned", respond_by: due, response_guaranteed: false });
    const stored = (await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(w.intentKey).first<string>("value"))!;
    ctx.now = due - 1;
    expect(await responseIntent(ctx, w.id)).toMatchObject({ state: "planned", revision: 1 });
    ctx.now = due;
    expect(await responseIntent(ctx, w.id)).toMatchObject({ state: "overdue", revision: 1, respond_by: due, notification: "not_requested" });
    expect(await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(w.intentKey).first("value")).toBe(stored);
    expect(await count()).toBe(1);
    expect(await setResponseIntent(ctx, w.id, "planned", 1, due + 60_000)).toMatchObject({ state: "planned", revision: 2 });
    expect(await setResponseIntent(ctx, w.id, "planned", 2)).toMatchObject({ state: "planned", revision: 3, respond_by: null });
    expect(await setResponseIntent(ctx, w.id, "cancelled", 3)).toMatchObject({ state: "cancelled", revision: 4, respond_by: null });
    for (const table of ["outbound_mail", "attention", "consent", "oauth_grant"]) expect(await env.HUB_DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n")).toBe(0);
  });
  it.each(["2026-02-29T12:00", "2026-04-31T12:00", "2026-10-10T24:00", "2026-10-10T12:60",
    "2026-10-10T12:00Z", "2026-10-10T12:00+01:00", "2026-10-10T12:00:00", "2026-1-1T1:00", "garbage", 123, {}, " 2026-10-10T12:00"]) (
    "refuses invalid/non-UTC-minute input %s rather than normalizing it", async value => {
      const w = await world();
      expect((await apiPost(host, "mail.set_response_intent", { id: w.id, state: "planned", expected_revision: 0, respond_by_utc: value }, w.headers)).status).toBe(400);
      expect(await count()).toBe(0);
      expect(await read(w)).toMatchObject({ state: "unset", revision: 0, respond_by: null });
    });
  it("interprets a valid calendar minute in explicit UTC and accepts blank optional input", () => {
    const id = "01M4AF980SG4A68Q7VNA21WX92";
    expect(mailSetResponseIntent.parse({ id, state: "planned", expected_revision: 0, respond_by_utc: "2028-02-29T12:34" }).due).toBe(Date.parse("2028-02-29T12:34:00Z"));
    for (const value of [undefined, null, ""]) expect(mailSetResponseIntent.parse({ id, state: "planned", expected_revision: 0, respond_by_utc: value }).due).toBeNull();
    expect(() => mailSetResponseIntent.parse({ id, state: "cancelled", expected_revision: 1, respond_by_utc: "2028-02-29T12:34" })).toThrow("cancellation");
  });
  it.each(["past", "equal", "too-late", "fractional", "nan", "cancelled"]) (
    "refuses %s deadline even on direct product entry, without a write", async change => {
      const w = await world();
      const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
      ctx.now = now + 60_000;
      const due = change === "past" ? ctx.now - 1 : change === "equal" ? ctx.now : change === "too-late" ? ctx.now + REPLY_WINDOW_MS + 1
        : change === "fractional" ? ctx.now + 0.5 : change === "nan" ? NaN : ctx.now + 60_000;
      await expect(setResponseIntent(ctx, w.id, change === "cancelled" ? "cancelled" : "planned", 0, due)).rejects.toThrow("future UTC time");
      expect(await count()).toBe(0);
      expect(await read(w)).toMatchObject({ state: "unset", revision: 0 });
    });
  it.each(["outside", "expired", "future-receipt"]) (
    "refuses %s received-message window for a deadline", async change => {
      const w = await world();
      const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
      ctx.now = change === "expired" ? now + REPLY_WINDOW_MS : now + 60_000;
      if (change === "future-receipt") await env.HUB_DB.prepare("UPDATE inbound_mail SET received_at = ? WHERE id = ?").bind(ctx.now + 1, w.id).run();
      const due = change === "outside" ? now + REPLY_WINDOW_MS + 1 : ctx.now + 60_000;
      await expect(setResponseIntent(ctx, w.id, "planned", 0, due)).rejects.toThrow("30 days of receiving");
      expect(await count()).toBe(0);
    });
  it("accepts the exact reply-window end and retains legacy untimed intent compatibility", async () => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    ctx.now = now + 60_000;
    expect((await setResponseIntent(ctx, w.id, "planned", 0, now + REPLY_WINDOW_MS)).respond_by).toBe(now + REPLY_WINDOW_MS);
    const stored = JSON.parse((await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(w.intentKey).first<string>("value"))!);
    delete stored.respond_by;
    await env.HUB_DB.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(JSON.stringify(stored), w.intentKey).run();
    ctx.now = now + REPLY_WINDOW_MS + 1;
    expect(await responseIntent(ctx, w.id)).toMatchObject({ state: "planned", revision: 1, respond_by: null });
    expect((await setResponseIntent(ctx, w.id, "cancelled", 1)).revision).toBe(2);
  });
  it.each(["received", "preferences"]) ("rechecks %s snapshot inside deadline retiming CAS", async change => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    ctx.now = now + 60_000;
    await setResponseIntent(ctx, w.id, "planned", 0, ctx.now + 60_000);
    const original = ctx.db.batch.bind(ctx.db);
    ctx.db = new Proxy(ctx.db, { get(db, key) {
      if (key !== "batch") { const v = Reflect.get(db, key); return typeof v === "function" ? v.bind(db) : v; }
      return async (stmts: D1PreparedStatement[]) => {
        if (change === "received") await env.HUB_DB.prepare("UPDATE inbound_mail SET received_at = received_at - 1 WHERE id = ?").bind(w.id).run();
        else await env.HUB_DB.prepare("UPDATE meta SET value = '{}' WHERE key = ?").bind(w.prefKey).run();
        return original(stmts);
      };
    } });
    await expect(setResponseIntent(ctx, w.id, "planned", 1, ctx.now + 120_000)).rejects.toThrow("eligibility changed");
    expect(await count()).toBe(1);
    expect(await responseIntent(ctx, w.id)).toMatchObject({ revision: 1, respond_by: ctx.now + 60_000 });
  });
  it("preserves stale authority over overdue timing, with cancellation after expiry and configuration removal", async () => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    ctx.now = now + 60_000;
    await setResponseIntent(ctx, w.id, "planned", 0, ctx.now + 60_000);
    await env.HUB_DB.prepare("UPDATE meta SET value = '{}' WHERE key = ?").bind(w.prefKey).run();
    ctx.now = now + REPLY_WINDOW_MS + 1;
    expect(await responseIntent(ctx, w.id)).toMatchObject({ state: "stale", revision: 1, can_plan: false });
    expect((await setResponseIntent(ctx, w.id, "cancelled", 1)).state).toBe("cancelled");
  });
  it.each(["bad", -1, 1.5, now, now + REPLY_WINDOW_MS * 2])("treats corrupt deadline %s as invalid, without silently clearing it", async due => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    ctx.now = now + 60_000;
    await setResponseIntent(ctx, w.id, "planned", 0);
    const stored = JSON.parse((await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(w.intentKey).first<string>("value"))!);
    stored.respond_by = due;
    await env.HUB_DB.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(JSON.stringify(stored), w.intentKey).run();
    expect(await responseIntent(ctx, w.id)).toMatchObject({ state: "invalid", revision: null, respond_by: null });
    await expect(setResponseIntent(ctx, w.id, "planned", 1, ctx.now + 60_000)).rejects.toThrow("requires reconciliation");
    expect(await count()).toBe(1);
  });
  it("serializes concurrent retimings and reconciles a lost response without replay", async () => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    ctx.now = now + 60_000;
    await setResponseIntent(ctx, w.id, "planned", 0, ctx.now + 60_000);
    const results = await Promise.allSettled([setResponseIntent(ctx, w.id, "planned", 1, ctx.now + 120_000), setResponseIntent(ctx, w.id, "planned", 1, ctx.now + 180_000)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await count()).toBe(2);
    const original = ctx.db.batch.bind(ctx.db);
    ctx.db = new Proxy(ctx.db, { get(db, key) {
      if (key !== "batch") { const v = Reflect.get(db, key); return typeof v === "function" ? v.bind(db) : v; }
      return async (stmts: D1PreparedStatement[]) => { await original(stmts); throw new Error("lost response"); };
    } });
    await expect(setResponseIntent(ctx, w.id, "planned", 2, ctx.now + 240_000)).rejects.toThrow("lost response");
    expect(await responseIntent(ctx, w.id)).toMatchObject({ state: "planned", revision: 3, respond_by: ctx.now + 240_000 });
    await expect(setResponseIntent(ctx, w.id, "planned", 2, ctx.now + 240_000)).rejects.toThrow("read before editing");
    expect(await count()).toBe(3);
  });
  it.each(["private", "foreign", "unproven", "unselected", "old-proof", "agent"])("a deadline does not bypass %s authority", async change => {
    const w = await world(); let headers = w.headers;
    if (change === "private") await env.HUB_DB.prepare("UPDATE inbound_mail SET recipient_id = ? WHERE id = ?").bind(w.bot.agent.identity.id, w.id).run();
    if (change === "foreign") await env.HUB_DB.prepare("UPDATE inbound_mail SET tenant_id = ? WHERE id = ?").bind(w.foreign.id, w.id).run();
    if (change === "unproven") await env.HUB_DB.prepare("DELETE FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
    if (change === "unselected") headers = w.adminHeaders;
    if (change === "old-proof") await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, w.member.session.id).run();
    if (change === "agent") headers = bearer(w.bot.token);
    const due = new Date(Date.now() + 180_000).toISOString().slice(0, 16);
    expect((await apiPost(host, "mail.set_response_intent", { id: w.id, state: "planned", expected_revision: 0, respond_by_utc: due }, headers)).status).not.toBe(200);
    expect(await count()).toBe(0);
    expect(await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(w.intentKey).first()).toBeNull();
  });
  it("rolls back retiming when audit fails and refuses an identical timed transition", async () => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    ctx.now = now + 60_000;
    await setResponseIntent(ctx, w.id, "planned", 0, ctx.now + 60_000);
    await expect(setResponseIntent(ctx, w.id, "planned", 1, ctx.now + 60_000)).rejects.toThrow("no response intent transition");
    ctx.session = { ...ctx.session!, id: "missing-session" };
    await expect(setResponseIntent(ctx, w.id, "planned", 1, ctx.now + 120_000)).rejects.toThrow();
    expect(await responseIntent(ctx, w.id)).toMatchObject({ revision: 1, respond_by: ctx.now + 60_000 });
    expect(await count()).toBe(1);
  });
  it("refuses a stored deadline on a cancelled intention instead of resurrecting it", async () => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    ctx.now = now + 60_000;
    await setResponseIntent(ctx, w.id, "planned", 0);
    await setResponseIntent(ctx, w.id, "cancelled", 1);
    const stored = JSON.parse((await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(w.intentKey).first<string>("value"))!);
    stored.respond_by = ctx.now + 60_000;
    await env.HUB_DB.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(JSON.stringify(stored), w.intentKey).run();
    expect(await responseIntent(ctx, w.id)).toMatchObject({ state: "invalid", revision: null, respond_by: null });
    await expect(setResponseIntent(ctx, w.id, "planned", 2, ctx.now + 120_000)).rejects.toThrow("requires reconciliation");
    expect(await count()).toBe(2);
  });
  it("renders explicit UTC native deadline fields, deadline values and overdue status with pane-key invalidation", async () => {
    const w = await world();
    const due = Math.ceil((Date.now() + 120_000) / 60_000) * 60_000;
    const text = new Date(due).toISOString().slice(0, 16);
    const html = await (await SELF.fetch(`https://${host}/mail/${w.id}`, { headers: w.headers })).text();
    expect(html).toContain("Optional respond-by (UTC)");
    expect(html).toContain('type="datetime-local" name="respond_by_utc" step="60"');
    const key = html.match(/id="inspector"[^>]*data-key="([^"]*)"/)![1];
    const body = new URLSearchParams({ id: w.id, state: "planned", expected_revision: "0", respond_by_utc: text, _back: `/mail/${w.id}` });
    const saved = await SELF.fetch(`https://${host}/api/mail.set_response_intent`, { method: "POST", body, headers: w.headers, redirect: "manual" });
    expect(saved.status).toBe(303);
    expect(await read(w)).toMatchObject({ respond_by: due, state: "planned" });
    const page = await (await SELF.fetch(`https://${host}/mail/${w.id}`, { headers: w.headers })).text();
    expect(page).toContain(`value="${text}"`);
    expect(page).toContain("Update my respond-by time");
    expect(page).toContain("Cancel my intention");
    expect(page.match(/id="inspector"[^>]*data-key="([^"]*)"/)![1]).not.toBe(key);
    expect((await SELF.fetch(`https://${host}/api/mail.set_response_intent`, { method: "POST", body, headers: w.headers, redirect: "manual" })).status).toBe(409);
    const value = JSON.parse((await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(w.intentKey).first<string>("value"))!);
    value.updated_at = Date.now() - 120_000; value.respond_by = Date.now() - 60_000;
    await env.HUB_DB.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(JSON.stringify(value), w.intentKey).run();
    const overdue = await (await SELF.fetch(`https://${host}/mail/${w.id}`, { headers: w.headers })).text();
    expect(overdue).toContain("intended respond-by time has passed");
    expect(overdue.match(/id="inspector"[^>]*data-key="([^"]*)"/)![1]).not.toBe(page.match(/id="inspector"[^>]*data-key="([^"]*)"/)![1]);
  });
  it.each([false, true])("explicitly self-reports completion, never delivery, for org/project=%s without send or access effects", async project => {
    const w = await world(project);
    expect((await set(w, "completed", 0)).status).toBe(409);
    expect((await set(w)).status).toBe(200);
    expect(await read(w)).toMatchObject({ can_complete: true, completion_evidence: "not_reported", recipient_delivery: "not_observed" });
    expect((await set(w, "completed", 1)).status).toBe(200);
    expect(await read(w)).toMatchObject({ state: "completed", revision: 2, can_complete: false, respond_by: null,
      completion_evidence: "self_reported", recipient_delivery: "not_observed", response_guaranteed: false,
      reply_observation: { state: "not_applicable", fulfillment: "not_inferred" } });
    expect(await read(w, cookieHeaders(w.other.token, host))).toMatchObject({ state: "unset", completion_evidence: "not_reported" });
    expect((await set(w, "completed", 2)).status).toBe(409);
    expect((await set(w, "cancelled", 2)).status).toBe(409);
    expect(await count()).toBe(2);
    const audit = await env.HUB_DB.prepare("SELECT summary FROM event WHERE kind = 'mail.set_response_intent' ORDER BY created_at DESC, id DESC LIMIT 1").first<string>("summary");
    expect(audit).toBe("Self-reported completion of own human response intention (recipient delivery not observed)");
    for (const table of ["outbound_mail", "attention", "consent", "oauth_grant"]) expect(await env.HUB_DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n")).toBe(0);
    expect((await set(w, "planned", 2)).status).toBe(200);
    expect(await read(w)).toMatchObject({ state: "planned", revision: 3, completion_evidence: "not_reported" });
    expect((await set(w, "cancelled", 3)).status).toBe(200);
    expect((await set(w, "completed", 4)).status).toBe(409);
  });
  it.each(["clear", "archive", "rename", "expired"]) ("permits a still-authorized owner to complete a prior plan after %s, not create a new assignment", async change => {
    const w = await world(change === "archive");
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    ctx.now = now + 60_000;
    await setResponseIntent(ctx, w.id, "planned", 0, ctx.now + 60_000);
    if (change === "clear") await env.HUB_DB.prepare("UPDATE meta SET value = '{}' WHERE key = ?").bind(w.prefKey).run();
    if (change === "archive") await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.project.id).run();
    if (change === "rename") await env.HUB_DB.prepare("UPDATE tenant SET slug = 'renamed' WHERE id = ?").bind(w.tenant.id).run();
    ctx.now = now + REPLY_WINDOW_MS + 1;
    expect(await responseIntent(ctx, w.id)).toMatchObject({ state: change === "expired" ? "overdue" : "stale", can_complete: true });
    expect(await setResponseIntent(ctx, w.id, "completed", 1)).toMatchObject({ state: "completed", respond_by: null, completion_evidence: "self_reported" });
    expect(await responseIntent(ctx, w.id)).toMatchObject({ state: "completed", revision: 2, can_complete: false });
  });
  it.each(["private", "foreign", "released", "unproven", "removed", "reader", "old-proof", "agent", "admin", "origin"]) ("completion cannot bypass %s authority or complete another person's plan", async change => {
    const w = await world();
    expect((await set(w)).status).toBe(200);
    let headers = w.headers;
    if (change === "private") await env.HUB_DB.prepare("UPDATE inbound_mail SET recipient_id = ? WHERE id = ?").bind(w.bot.agent.identity.id, w.id).run();
    if (change === "foreign") await env.HUB_DB.prepare("UPDATE inbound_mail SET tenant_id = ? WHERE id = ?").bind(w.foreign.id, w.id).run();
    if (change === "released") await env.HUB_DB.prepare("UPDATE inbound_mail SET released_by = ? WHERE id = ?").bind(w.admin.identity.id, w.id).run();
    if (change === "unproven") await env.HUB_DB.prepare("DELETE FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
    if (change === "removed") await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ?").bind(w.member.identity.id).run();
    if (change === "reader") await env.HUB_DB.prepare("UPDATE membership SET role = 'reader' WHERE identity_id = ?").bind(w.member.identity.id).run();
    if (change === "old-proof") await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, w.member.session.id).run();
    if (change === "agent") headers = bearer(w.bot.token);
    if (change === "admin") headers = w.adminHeaders;
    if (change === "origin") headers = { ...w.headers, origin: "https://evil.test" };
    expect((await set(w, "completed", 1, headers)).status).not.toBe(200);
    expect(await count()).toBe(1);
    expect(JSON.parse((await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(w.intentKey).first<string>("value"))!).state).toBe("planned");
  });
  it.each(["member", "proof", "mail", "intent"]) ("completion rechecks %s in its atomic revision/audit write", async change => {
    const w = await world(); expect((await set(w)).status).toBe(200);
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    const original = ctx.db.batch.bind(ctx.db);
    ctx.db = new Proxy(ctx.db, { get(db, key) {
      if (key !== "batch") { const v = Reflect.get(db, key); return typeof v === "function" ? v.bind(db) : v; }
      return async (stmts: D1PreparedStatement[]) => {
        if (change === "member") await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ?").bind(w.member.identity.id).run();
        if (change === "proof") await env.HUB_DB.prepare("DELETE FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
        if (change === "mail") await env.HUB_DB.prepare("UPDATE inbound_mail SET verdict = 'quarantined' WHERE id = ?").bind(w.id).run();
        if (change === "intent") await env.HUB_DB.prepare("DELETE FROM meta WHERE key = ?").bind(w.intentKey).run();
        return original(stmts);
      };
    } });
    await expect(setResponseIntent(ctx, w.id, "completed", 1)).rejects.toThrow("eligibility changed");
    expect(await count()).toBe(1);
  });
  it("serializes completion against cancellation and requires reconciliation after a lost completion result", async () => {
    const w = await world(); expect((await set(w)).status).toBe(200);
    expect((await Promise.all([set(w, "completed", 1), set(w, "cancelled", 1)])).map(r => r.status).sort()).toEqual([200, 409]);
    expect(await count()).toBe(2);
    expect((await set(w, "planned", 2)).status).toBe(200);
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    const original = ctx.db.batch.bind(ctx.db);
    ctx.db = new Proxy(ctx.db, { get(db, key) {
      if (key !== "batch") { const v = Reflect.get(db, key); return typeof v === "function" ? v.bind(db) : v; }
      return async (stmts: D1PreparedStatement[]) => { await original(stmts); throw new Error("lost completion result"); };
    } });
    await expect(setResponseIntent(ctx, w.id, "completed", 3)).rejects.toThrow("lost completion result");
    expect(await read(w)).toMatchObject({ state: "completed", revision: 4, completion_evidence: "self_reported" });
    expect((await set(w, "completed", 3)).status).toBe(409);
    expect(await count()).toBe(4);
  });
  it("refuses completed deadlines/corrupt plans and rolls completion back if its audit fails", async () => {
    const w = await world(); expect((await set(w)).status).toBe(200);
    const ctx = await buildContext(new Request(`https://${host}/api/mail.set_response_intent`, { headers: w.headers }), env);
    await expect(setResponseIntent(ctx, w.id, "completed", 1, ctx.now + 60_000)).rejects.toThrow("future UTC time");
    expect(() => mailSetResponseIntent.parse({ id: w.id, state: "completed", expected_revision: 1, respond_by_utc: "2028-02-29T12:34" })).toThrow("completion");
    ctx.session = { ...ctx.session!, id: "missing-session" };
    await expect(setResponseIntent(ctx, w.id, "completed", 1)).rejects.toThrow();
    expect(await read(w)).toMatchObject({ state: "planned", revision: 1 });
    expect(await count()).toBe(1);
    expect((await set(w, "completed", 1)).status).toBe(200);
    const stored = JSON.parse((await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(w.intentKey).first<string>("value"))!);
    stored.respond_by = stored.updated_at + 60_000;
    await env.HUB_DB.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(JSON.stringify(stored), w.intentKey).run();
    expect(await read(w)).toMatchObject({ state: "invalid", revision: null, can_complete: false, completion_evidence: "not_reported" });
    expect((await set(w, "completed", 2)).status).toBe(409);
    expect(await count()).toBe(2);
  });
  it("offers a revision-safe explicit self-report form, clears the deadline and invalidates the inspector pane", async () => {
    const w = await world(); expect((await set(w)).status).toBe(200);
    const page = () => SELF.fetch(`https://${host}/mail/${w.id}`, { headers: w.headers });
    const before = await (await page()).text();
    expect(before).toContain('name="state" value="completed"');
    expect(before).toContain("I have completed my response");
    expect(before).toContain("Record only if you have completed your intended response");
    const body = new URLSearchParams({ id: w.id, state: "completed", expected_revision: "1", _back: `/mail/${w.id}` });
    const post = () => SELF.fetch(`https://${host}/api/mail.set_response_intent`, { method: "POST", body, headers: w.headers, redirect: "manual" });
    expect((await post()).status).toBe(303);
    const after = await (await page()).text();
    expect(after).toContain("You self-reported that you completed your response intention");
    expect(after).toContain("not observed recipient delivery or independently verified fulfillment");
    expect(after).not.toContain('name="state" value="completed"');
    expect(after).not.toContain("Cancel my intention");
    expect(after.match(/id="inspector"[^>]*data-key="([^"]*)"/)![1]).not.toBe(before.match(/id="inspector"[^>]*data-key="([^"]*)"/)![1]);
    expect((await post()).status).toBe(409);
    expect(await count()).toBe(2);
  });
  it("requires fresh proof for the completion browser form, without a hidden save", async () => {
    const w = await world(); expect((await set(w)).status).toBe(200);
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, w.member.session.id).run();
    const html = await (await SELF.fetch(`https://${host}/mail/${w.id}`, { headers: w.headers })).text();
    expect(html).toContain("recent confirmation");
    expect(html).not.toContain('action="/api/mail.set_response_intent"');
    const body = new URLSearchParams({ id: w.id, state: "completed", expected_revision: "1", _back: `/mail/${w.id}` });
    const r = await SELF.fetch(`https://${host}/api/mail.set_response_intent`, { method: "POST", body, headers: w.headers, redirect: "manual" });
    expect(r.status).toBe(303); expect(r.headers.get("location")).toContain("/login?reproof=1");
    expect(await read(w)).toMatchObject({ state: "planned", revision: 1 });
    expect(await count()).toBe(1);
  });
  it("cleans only the deleted tenant's intent keys", async () => {
    const w = await world();
    expect((await set(w)).status).toBe(200);
    const keep = `${RESPONSE_INTENT_PREFIX}${w.foreign.id}:keep`;
    await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, 'keep')").bind(keep).run();
    await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(w.tenant.id).run();
    await deleteTenant(env.HUB_DB, "intent", w.admin.identity.id, Date.now());
    expect((await env.HUB_DB.prepare("SELECT key FROM meta WHERE key GLOB ?").bind(RESPONSE_INTENT_PREFIX + "*").all()).results).toEqual([{ key: keep }]);
  });
});
