import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import fixtures from "./fixtures/dkim.json";
import { registerAllVerbs } from "../src/verbs/index";
import { getVerb } from "../src/verbs/table";
import { checkAccess } from "../src/verbs/dispatch";
import { buildContext } from "../src/auth/context";
import { handleApi } from "../src/http/api";
import { storeIndependentMailCandidate, REPLAY_PREFIX } from "../src/mail/replay";
import { RESPONSE_RECIPIENT_PREFIX } from "../src/mail/responseRecipients";
import { RESPONSE_INTENT_PREFIX, RESPONSE_INTENT_WRITE_PREFIX, responseIntent, responseIntentWriteStatus, setResponseIntent } from "../src/mail/responseIntent";
import { REPLY_WINDOW_MS } from "../src/mail/limits";
import { mailSetResponseIntent } from "../src/verbs/mailIntent";
import { ulid } from "../src/ids";
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

describe("browser exact intention receipt checks", () => {
  const form = (w: Awaited<ReturnType<typeof world>>, request = ulid()) => new URLSearchParams({
    id: w.id, request_id: request, state: "planned", expected_revision: "0", respond_by_utc: "", _back: `/mail/${w.id}`,
  });
  const post = (w: Awaited<ReturnType<typeof world>>, verb: string, body: URLSearchParams, headers = w.headers) =>
    SELF.fetch(`https://${host}/api/${verb}`, { method: "POST", body, headers, redirect: "manual" });
  it.each([false, true])("renders keyed native forms and checks exact org/project=%s edits without replay", async project => {
    const w = await world(project);
    const html = await (await SELF.fetch(`https://${host}/mail/${w.id}`, { headers: w.headers })).text();
    const request = html.match(/name="request_id" value="([0-9A-Z]{26})" readonly/)![1];
    expect(html).toContain('formaction="/api/mail.response_intent_write_status"');
    expect(html).toContain('action="/api/mail.response_intent_write_status" data-reload');
    expect(html).toContain("Preserve these values and the exact UTC time");
    const body = form(w, request);
    const absent = await post(w, "mail.response_intent_write_status", body);
    expect(absent.status).toBe(200); expect(absent.headers.get("cache-control")).toBe("no-store");
    expect(await absent.text()).toContain("This does not prove that nothing changed");
    expect(await count()).toBe(0);
    expect((await post(w, "mail.set_response_intent", body)).status).toBe(303);
    const exact = await post(w, "mail.response_intent_write_status", body);
    const checked = await exact.text(); expect(checked).toContain("original recorded edit matches your submitted values");
    expect(checked).toContain("original recorded intention is still current");
    expect(checked).toContain(`href="/mail/${w.id}"`);
    expect(checked).not.toContain('action="/api/mail.set_response_intent"');
    body.set("state", "cancelled");
    expect(await (await post(w, "mail.response_intent_write_status", body)).text()).toContain("recorded for a different edit");
    expect(await count()).toBe(1);
    for (const table of ["outbound_mail", "attention", "consent", "oauth_grant"]) expect(await env.HUB_DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n")).toBe(0);
  });
  it("lets stale-proof humans read preserved receipts after later edits without refreshing proof", async () => {
    const w = await world(), body = form(w);
    expect((await post(w, "mail.set_response_intent", body)).status).toBe(303);
    expect((await set(w, "completed", 1)).status).toBe(200);
    const time = Date.now() - 61 * 60_000;
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(time, w.member.session.id).run();
    const html = await (await SELF.fetch(`https://${host}/mail/${w.id}`, { headers: w.headers })).text();
    expect(html).not.toContain('action="/api/mail.set_response_intent"');
    expect(html).toContain("Check a preserved intention edit");
    const checked = await post(w, "mail.response_intent_write_status", body);
    expect(checked.status).toBe(200); expect(await checked.text()).toContain("original recorded intention is no longer current");
    expect(await env.HUB_DB.prepare("SELECT last_proof_at FROM session WHERE id = ?").bind(w.member.session.id).first("last_proof_at")).toBe(time);
    expect(await count()).toBe(2);
  });
  it("renders invalid receipts without resetting them or encouraging a retry", async () => {
    const w = await world(), body = form(w);
    expect((await post(w, "mail.set_response_intent", body)).status).toBe(303);
    const key = `${RESPONSE_INTENT_WRITE_PREFIX}${w.tenant.id}:${w.id}:${w.member.identity.id}:${body.get("request_id")}`;
    await env.HUB_DB.prepare("UPDATE meta SET value = '{}' WHERE key = ?").bind(key).run();
    const response = await post(w, "mail.response_intent_write_status", body);
    expect(response.status).toBe(200); const html = await response.text();
    expect(html).toContain("stored receipt or source binding is invalid"); expect(html).toContain("not retry authorization");
    expect(await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first("value")).toBe("{}");
    expect(await count()).toBe(1);
  });
  it.each([false, true])("never claims no change for a transaction error (committed=%s)", async committed => {
    const w = await world(), body = form(w), db = env.HUB_DB;
    let editing = false;
    const faulty = new Proxy(db, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        if (sql.startsWith("INSERT INTO meta (key, value) SELECT ?, ? FROM inbound_mail m")) editing = true;
        return db.prepare(sql);
      };
      if (key === "batch") return async (stmts: D1PreparedStatement[]) => {
        if (!editing) return db.batch(stmts);
        if (committed) await db.batch(stmts);
        throw new Error("test transaction response unavailable");
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const response = await handleApi(new Request(`https://${host}/api/mail.set_response_intent`, { method: "POST", body, headers: w.headers }), { ...env, HUB_DB: faulty });
    expect(response.status).toBe(500); expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text(); expect(html).toContain("Save outcome unknown"); expect(html).toContain("may already have committed");
    expect(html).not.toContain("Nothing was changed"); expect(html).not.toContain('action="/api/mail.set_response_intent"');
    const checked = await post(w, "mail.response_intent_write_status", body);
    expect(checked.status).toBe(200);
    expect(await checked.text()).toContain(committed ? "original recorded edit matches" : "No receipt is currently recorded");
    expect(await count()).toBe(committed ? 1 : 0);
  });
  it.each(["origin", "reader", "agent", "foreign", "private", "proof", "member"])("refuses browser receipt disclosure for %s", async change => {
    const w = await world(), body = form(w); let headers = w.headers;
    expect((await post(w, "mail.set_response_intent", body)).status).toBe(303);
    if (change === "origin") headers = { ...headers, origin: "https://evil.test" };
    if (change === "reader") headers = cookieHeaders(w.reader.token, host);
    if (change === "agent") headers = bearer(w.bot.token);
    if (change === "foreign") { const human = await seedHuman("foreign@example.com", { memberships: [{ tenant_id: w.foreign.id, role: "member" }] }); headers = cookieHeaders(human.token, host); }
    if (change === "private") await env.HUB_DB.prepare("UPDATE inbound_mail SET recipient_id = ? WHERE id = ?").bind(w.bot.agent.identity.id, w.id).run();
    if (change === "proof") await env.HUB_DB.prepare("DELETE FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
    if (change === "member") await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE tenant_id = ? AND identity_id = ?").bind(w.tenant.id, w.member.identity.id).run();
    const response = await post(w, "mail.response_intent_write_status", body, headers);
    expect(response.status).not.toBe(200); expect(await response.text()).not.toContain("Own intention edit receipt");
    expect(await count()).toBe(1);
  });
});

describe("durable own response-intention write reconciliation (not delivery or retry authorization)", () => {
  type World = Awaited<ReturnType<typeof world>>;
  const payload = (w: World, request = ulid(), state = "planned", revision = 0) =>
    ({ id: w.id, request_id: request, state, expected_revision: revision });
  const save = (w: World, body: Record<string, unknown>) => apiPost(host, "mail.set_response_intent", body, w.headers);
  const status = (w: World, body: Record<string, unknown>, headers = w.headers) =>
    apiPost(host, "mail.response_intent_write_status", body, headers);
  const receiptKey = (w: World, request: string) => `${RESPONSE_INTENT_WRITE_PREFIX}${w.tenant.id}:${w.id}:${w.member.identity.id}:${request}`;
  const result = async (r: Response) => { expect(r.status, await r.clone().text()).toBe(200); return (await r.json() as { result: Record<string, any> }).result; };
  const context = (w: World) => buildContext(new Request(`https://${host}/api/mail.response_intent_write_status`, { headers: w.headers }), env);
  it.each([false, true])("reconciles exact committed org/project=%s edits after later revisions without replaying them", async project => {
    const w = await world(project), body = payload(w);
    expect(await result(await status(w, body))).toMatchObject({ status: "no_record", matches: null, still_current: null, retry_authorized: false });
    expect(await result(await save(w, body))).toMatchObject({ revision: 1, request_id: body.request_id });
    expect(await result(await status(w, body))).toMatchObject({ status: "committed", matches: true, committed_revision: 1, current_revision: 1, still_current: true, retry_authorized: false });
    const cancel = payload(w, ulid(), "cancelled", 1);
    expect((await save(w, cancel)).status).toBe(200);
    expect(await result(await status(w, body))).toMatchObject({ status: "committed", matches: true, committed_revision: 1, current_revision: 2, still_current: false });
    expect(await result(await status(w, cancel))).toMatchObject({ status: "committed", matches: true, committed_revision: 2, still_current: true });
    for (const changed of [body, { ...body, state: "completed", expected_revision: 2 }, { ...body, expected_revision: 2 }]) expect((await save(w, changed)).status).toBe(409);
    expect(await count()).toBe(2);
    for (const table of ["outbound_mail", "attention", "consent", "oauth_grant"]) expect(await env.HUB_DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n")).toBe(0);
  });
  it("binds expected revision, state and UTC deadline; a past deadline can still be reconciled", async () => {
    const w = await world(), ctx = await context(w), request = ulid(), due = ctx.now + 60_000;
    await setResponseIntent(ctx, w.id, "planned", 0, due, request);
    const later = { ...ctx, now: due + 1 };
    expect(await responseIntentWriteStatus(later, w.id, request, "planned", 0, due)).toMatchObject({ status: "committed", matches: true });
    for (const [state, revision, time] of [["planned", 1, due], ["cancelled", 0, null], ["planned", 0, null], ["planned", 0, due + 1]] as const) {
      expect(await responseIntentWriteStatus(later, w.id, request, state, revision, time)).toMatchObject({ status: "committed", matches: false, retry_authorized: false });
    }
    const complete = payload(w, ulid(), "completed", 1);
    expect((await save(w, complete)).status).toBe(200);
    expect(await result(await status(w, complete))).toMatchObject({ matches: true, committed_revision: 2 });
  });
  it("keeps request receipts scoped to caller, source and tenant, including the same request alias", async () => {
    const w = await world(), body = payload(w);
    expect((await save(w, body)).status).toBe(200);
    expect(await result(await status(w, body, cookieHeaders(w.other.token, host)))).toMatchObject({ status: "no_record", matches: null });
    expect(await result(await status(w, body, w.adminHeaders))).toMatchObject({ status: "no_record" });
    expect((await apiPost(host, "mail.set_response_intent", body, cookieHeaders(w.other.token, host))).status).toBe(200);
    const second = await storeIndependentMailCandidate(env, { bytes: new TextEncoder().encode(fixtures.valid), from: w.member.identity.email, to: "intent.site@pimwell.test" }, now, async () => [[fixtures.record]]);
    if (second.status !== "stored") throw new Error("second source not stored");
    expect(await result(await status(w, { ...body, id: second.mail_id }))).toMatchObject({ status: "no_record" });
    expect((await apiPost("foreign.pimwell.test", "mail.response_intent_write_status", body, cookieHeaders(w.member.token, "foreign.pimwell.test"))).status).not.toBe(200);
  });
  it("commits the intent/receipt/audit once despite concurrent identical requests", async () => {
    const w = await world(), body = payload(w);
    expect((await Promise.all([save(w, body), save(w, body)])).map(r => r.status).sort()).toEqual([200, 409]);
    expect(await count()).toBe(1);
    expect(await result(await status(w, body))).toMatchObject({ status: "committed", matches: true });
  });
  it("reconciles a lost commit response, and preserves the receipt after current intention deletion", async () => {
    const w = await world(), ctx = await context(w), body = payload(w), original = ctx.db.batch.bind(ctx.db);
    ctx.db = new Proxy(ctx.db, { get(db, key) {
      if (key !== "batch") { const v = Reflect.get(db, key); return typeof v === "function" ? v.bind(db) : v; }
      return async (stmts: D1PreparedStatement[]) => { await original(stmts); throw new Error("lost commit result"); };
    } });
    await expect(setResponseIntent(ctx, w.id, "planned", 0, null, body.request_id)).rejects.toThrow("lost commit result");
    expect(await result(await status(w, body))).toMatchObject({ status: "committed", matches: true });
    await env.HUB_DB.prepare("DELETE FROM meta WHERE key = ?").bind(w.intentKey).run();
    expect(await result(await status(w, body))).toMatchObject({ status: "committed", matches: true, current_revision: 0, still_current: false });
    expect((await save(w, body)).status).toBe(409);
    expect(await count()).toBe(1);
  });
  it("rolls back the receipt and intent on audit failure; absence never authorizes retry", async () => {
    const w = await world(), ctx = await context(w), body = payload(w);
    ctx.session = { ...ctx.session!, id: "missing-session" };
    await expect(setResponseIntent(ctx, w.id, "planned", 0, null, body.request_id)).rejects.toThrow();
    expect(await result(await status(w, body))).toMatchObject({ status: "no_record", current_revision: 0, retry_authorized: false });
    expect(await count()).toBe(0);
  });
  it.each([null, "", "bad", "a".repeat(27), "01m4faktzn5k8r70yek82b5s8s"])("rejects invalid status request alias %s", async request => {
    const w = await world(); expect((await status(w, { ...payload(w), request_id: request })).status).toBe(400);
  });
  it("retains legacy CAS without silently inventing a durable receipt", async () => {
    const w = await world(), body = payload(w);
    expect((await set(w)).status).toBe(200);
    expect(await result(await status(w, body))).toMatchObject({ status: "no_record", current_revision: 1 });
    expect((await set(w)).status).toBe(409);
  });
  it.each(["{}", "not-json", "future", "source"])("fails closed for %s receipt without replacing it", async change => {
    const w = await world(), body = payload(w); expect((await save(w, body)).status).toBe(200);
    const key = receiptKey(w, body.request_id), original = await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<string>("value");
    const value = JSON.parse(original!);
    if (change === "future") value.result.updated_at = Date.now() + 86_400_000;
    if (change === "source") value.source = "0".repeat(64);
    await env.HUB_DB.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(["{}", "not-json"].includes(change) ? change : JSON.stringify(value), key).run();
    expect(await result(await status(w, body))).toMatchObject({ status: "invalid", matches: null, committed_revision: null, retry_authorized: false });
    expect((await save(w, body)).status).toBe(409); expect(await count()).toBe(1);
  });
  it.each(["private", "released", "quarantine", "proof", "member", "root"])("does not disclose committed receipts after %s authority/evidence loss", async change => {
    const w = await world(), body = payload(w); expect((await save(w, body)).status).toBe(200);
    if (change === "private") await env.HUB_DB.prepare("UPDATE inbound_mail SET recipient_id = ? WHERE id = ?").bind(w.bot.agent.identity.id, w.id).run();
    if (change === "released") await env.HUB_DB.prepare("UPDATE inbound_mail SET released_by = ? WHERE id = ?").bind(w.admin.identity.id, w.id).run();
    if (change === "quarantine") await env.HUB_DB.prepare("UPDATE inbound_mail SET verdict = 'quarantined' WHERE id = ?").bind(w.id).run();
    if (change === "proof") await env.HUB_DB.prepare("DELETE FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
    if (change === "member" || change === "root") await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ?").bind(w.member.identity.id).run();
    if (change === "root") await env.HUB_DB.prepare("UPDATE identity SET is_root = 1 WHERE id = ?").bind(w.member.identity.id).run();
    const r = await status(w, body); expect(r.status).not.toBe(200); expect(await r.text()).not.toContain("committed_revision");
  });
  it("allows stale-proof read reconciliation without refreshing proof or allowing an agent, reader or bad Origin", async () => {
    const w = await world(), body = payload(w); expect((await save(w, body)).status).toBe(200);
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, w.member.session.id).run();
    const snapshot = (await env.HUB_DB.prepare("SELECT * FROM meta ORDER BY key").all()).results;
    expect(await result(await status(w, body))).toMatchObject({ matches: true });
    expect((await save(w, payload(w, ulid(), "cancelled", 1))).status).toBe(403);
    for (const headers of [bearer(w.bot.token), cookieHeaders(w.reader.token, host), {}, { cookie: w.headers.cookie!, origin: "https://evil.test" }]) expect((await status(w, body, headers)).status).not.toBe(200);
    expect(getVerb("mail.response_intent_write_status")!.mcp).toBeUndefined();
    expect((await env.HUB_DB.prepare("SELECT * FROM meta ORDER BY key").all()).results).toEqual(snapshot);
    expect(await count()).toBe(1);
  });
  it.each(["receipt", "absent", "source", "intent", "proof", "member", "preference"])("refuses %s changes in the final read observation", async change => {
    const w = await world(), body = payload(w), ctx = await context(w);
    if (change !== "absent") expect((await save(w, body)).status).toBe(200);
    const original = ctx.db.prepare.bind(ctx.db);
    ctx.db = new Proxy(ctx.db, { get(db, prop) {
      if (prop !== "prepare") { const v = Reflect.get(db, prop); return typeof v === "function" ? v.bind(db) : v; }
      return (sql: string) => {
        const stmt = original(sql);
        if (!sql.startsWith("SELECT o.id")) return stmt;
        return { bind: (...bindings: unknown[]) => ({ first: async () => {
          if (change === "receipt") await env.HUB_DB.prepare("UPDATE meta SET value = '{}' WHERE key = ?").bind(receiptKey(w, body.request_id)).run();
          if (change === "absent") await env.HUB_DB.prepare("INSERT INTO meta VALUES (?, '{}')").bind(receiptKey(w, body.request_id)).run();
          if (change === "source") await env.HUB_DB.prepare("UPDATE inbound_mail SET received_at = received_at + 1 WHERE id = ?").bind(w.id).run();
          if (change === "intent") await env.HUB_DB.prepare("DELETE FROM meta WHERE key = ?").bind(w.intentKey).run();
          if (change === "proof") await env.HUB_DB.prepare("DELETE FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
          if (change === "member") await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ?").bind(w.member.identity.id).run();
          if (change === "preference") await env.HUB_DB.prepare("UPDATE meta SET value = '{}' WHERE key = ?").bind(w.prefKey).run();
          return stmt.bind(...bindings).first();
        } }) };
      };
    } });
    await expect(responseIntentWriteStatus(ctx, w.id, body.request_id, "planned", 0)).rejects.toThrow("changed; read again");
  });
  it("rolls back a concurrent request collision without overwriting its receipt or auditing a false change", async () => {
    const w = await world(), ctx = await context(w), body = payload(w), key = receiptKey(w, body.request_id), original = ctx.db.batch.bind(ctx.db);
    ctx.db = new Proxy(ctx.db, { get(db, prop) {
      if (prop !== "batch") { const v = Reflect.get(db, prop); return typeof v === "function" ? v.bind(db) : v; }
      return async (stmts: D1PreparedStatement[]) => {
        await env.HUB_DB.prepare("INSERT INTO meta VALUES (?, '{}')").bind(key).run(); return original(stmts);
      };
    } });
    await expect(setResponseIntent(ctx, w.id, "planned", 0, null, body.request_id)).rejects.toThrow("eligibility changed");
    expect(await read(w)).toMatchObject({ state: "unset" }); expect(await count()).toBe(0);
    expect(await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first("value")).toBe("{}");
  });
  it("rolls back the intention when receipt storage fails before audit", async () => {
    const w = await world(), ctx = await context(w), body = payload(w), original = ctx.db.batch.bind(ctx.db);
    ctx.db = new Proxy(ctx.db, { get(db, prop) {
      if (prop !== "batch") { const v = Reflect.get(db, prop); return typeof v === "function" ? v.bind(db) : v; }
      return (stmts: D1PreparedStatement[]) => {
        expect(stmts).toHaveLength(3);
        return original([stmts[0]!, env.HUB_DB.prepare("INSERT INTO session (id) VALUES ('invalid-receipt-fixture')"), stmts[2]!]);
      };
    } });
    await expect(setResponseIntent(ctx, w.id, "planned", 0, null, body.request_id)).rejects.toThrow();
    expect(await result(await status(w, body))).toMatchObject({ status: "no_record", current_revision: 0 });
    expect(await count()).toBe(0);
  });
  it("refuses receipt timestamp changes before a keyed untimed write commits", async () => {
    const w = await world(), ctx = await context(w), body = payload(w), original = ctx.db.batch.bind(ctx.db);
    ctx.db = new Proxy(ctx.db, { get(db, prop) {
      if (prop !== "batch") { const v = Reflect.get(db, prop); return typeof v === "function" ? v.bind(db) : v; }
      return async (stmts: D1PreparedStatement[]) => {
        await env.HUB_DB.prepare("UPDATE inbound_mail SET received_at = received_at + 1 WHERE id = ?").bind(w.id).run(); return original(stmts);
      };
    } });
    await expect(setResponseIntent(ctx, w.id, "planned", 0, null, body.request_id)).rejects.toThrow("eligibility changed");
    expect(await result(await status(w, body))).toMatchObject({ status: "no_record", current_revision: 0 });
    expect(await count()).toBe(0);
  });
  it("reports changed server-owned source snapshots as invalid, without exposing the original receipt", async () => {
    const w = await world(), body = payload(w); expect((await save(w, body)).status).toBe(200);
    await env.HUB_DB.prepare("UPDATE inbound_mail SET received_at = received_at + 1 WHERE id = ?").bind(w.id).run();
    expect(await result(await status(w, body))).toMatchObject({ status: "invalid", matches: null, committed_revision: null, recorded_at: null, still_current: null });
    expect(await count()).toBe(1);
  });
  it("propagates database failures instead of fabricating no_record", async () => {
    const w = await world(), ctx = await context(w), request = ulid(), original = ctx.db.prepare.bind(ctx.db);
    ctx.db = new Proxy(ctx.db, { get(db, prop) {
      if (prop !== "prepare") { const v = Reflect.get(db, prop); return typeof v === "function" ? v.bind(db) : v; }
      return (sql: string) => sql.startsWith("SELECT o.id") ? { bind: () => ({ first: () => { throw new Error("database unavailable"); } }) } : original(sql);
    } });
    await expect(responseIntentWriteStatus(ctx, w.id, request, "planned", 0)).rejects.toThrow("database unavailable");
    expect(await count()).toBe(0);
  });
  it("cleans only the deleted tenant's durable request receipts", async () => {
    const w = await world(), body = payload(w); expect((await save(w, body)).status).toBe(200);
    const keep = `${RESPONSE_INTENT_WRITE_PREFIX}${w.foreign.id}:keep`;
    await env.HUB_DB.prepare("INSERT INTO meta VALUES (?, 'keep')").bind(keep).run();
    await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(w.tenant.id).run();
    await deleteTenant(env.HUB_DB, "intent", w.admin.identity.id, Date.now());
    expect((await env.HUB_DB.prepare("SELECT key FROM meta WHERE key GLOB ?").bind(RESPONSE_INTENT_WRITE_PREFIX + "*").all()).results).toEqual([{ key: keep }]);
  });
});
