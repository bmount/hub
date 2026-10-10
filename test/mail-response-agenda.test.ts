import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import fixtures from "./fixtures/dkim.json";
import { buildContext } from "../src/auth/context";
import { createProject } from "../src/db/projects";
import { sha256Hex, ulid } from "../src/ids";
import { REPLAY_PREFIX, storeIndependentMailCandidate } from "../src/mail/replay";
import { RESPONSE_INTENT_PREFIX, responseAgenda, RESPONSE_AGENDA_SCAN, setResponseIntent } from "../src/mail/responseIntent";
import { RESPONSE_RECIPIENT_PREFIX } from "../src/mail/responseRecipients";
import { registerAllVerbs } from "../src/verbs/index";
import { checkAccess } from "../src/verbs/dispatch";
import { mailAgendaPage } from "../src/http/mailAgendaPage";
import { getVerb } from "../src/verbs/table";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const host = "agenda.pimwell.test";
beforeAll(registerAllVerbs);
async function world(projectMail = false) {
  const tenant = await seedTenant("agenda"), foreign = await seedTenant("foreign");
  const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: tenant.id, role: "admin" }] });
  const member = await seedHuman("member@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const other = await seedHuman("other@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: tenant.id, role: "reader" }] });
  const bot = await seedAgent(tenant, admin.identity);
  const project = await createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug: "site", display_name: "Site", kind: "tracker" }, Date.now());
  const to = projectMail ? "agenda.site@pimwell.test" : "agenda@pimwell.test";
  const stored = await storeIndependentMailCandidate(env, { bytes: new TextEncoder().encode(fixtures.valid), from: member.identity.email, to }, Date.parse(fixtures.now), async () => [[fixtures.record]]);
  if (stored.status !== "stored") throw new Error("fixture not admitted");
  const headers = cookieHeaders(member.token, host);
  expect((await apiPost(host, "mail.set_response_recipients", { address: to, recipients: [member.identity.id], expected_revision: 0 }, cookieHeaders(admin.token, host))).status).toBe(200);
  const ctx = await buildContext(new Request(`https://${host}/api/mail.response_agenda`, { headers }), env);
  const key = `${RESPONSE_INTENT_PREFIX}${tenant.id}:${stored.mail_id}:${member.identity.id}`;
  const prefKey = `${RESPONSE_RECIPIENT_PREFIX}${tenant.id}:${projectMail ? project.id : "org"}`;
  return { tenant, foreign, admin, member, other, reader, bot, project, headers, ctx, id: stored.mail_id, key, prefKey };
}
type World = Awaited<ReturnType<typeof world>>;
const api = (w: World, body = {}, headers = w.headers) => apiPost(host, "mail.response_agenda", body, headers);
const snapshot = async () => (await env.HUB_DB.batch(["meta", "event", "inbound_mail", "outbound_mail", "attention", "membership", "consent", "oauth_grant"].map(t => env.HUB_DB.prepare(`SELECT * FROM ${t}`)))).map(r => r.results);
async function storedIntent(w: World, state = "planned", due: number | null = null) {
  await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(w.key, JSON.stringify({ revision: 1, state, respond_by: due, updated_at: w.ctx.now - 10_000, change_id: ulid(w.ctx.now) })).run();
}
// Disposable server-owned state fixtures for pagination, not claims of provider DKIM acceptance.
async function cloneSource(w: World, index: number, state = "planned") {
  const id = ulid(w.ctx.now + index), message = `<agenda-${index}@example.com>`;
  await env.HUB_DB.prepare(`INSERT INTO inbound_mail (id, tenant_id, project_id, identity_id, from_email, to_address, subject, message_id, received_at, size, verdict, text, attachments, forwarded)
    SELECT ?, tenant_id, project_id, identity_id, from_email, to_address, 'secret subject', ?, received_at, size, verdict, 'secret body', attachments, forwarded FROM inbound_mail WHERE id = ?`)
    .bind(id, message, w.id).run();
  const row = (await env.HUB_DB.prepare("SELECT from_email, to_address FROM inbound_mail WHERE id = ?").bind(id).first<{ from_email: string; to_address: string }>())!;
  const template = (await env.HUB_DB.prepare("SELECT value FROM meta WHERE key GLOB ? LIMIT 1").bind(REPLAY_PREFIX + "*").first<string>("value"))!;
  const proof = { ...JSON.parse(template), mail_id: id };
  const replayKey = REPLAY_PREFIX + w.tenant.id + ":" + await sha256Hex(JSON.stringify([row.from_email, row.to_address, message]));
  await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").bind(replayKey, JSON.stringify(proof)).run();
  await storedIntent({ ...w, id, key: `${RESPONSE_INTENT_PREFIX}${w.tenant.id}:${id}:${w.member.identity.id}` }, state);
  return id;
}
// Run a mutation immediately after the agenda scan or before its final authority read.
function interleave(w: World, at: "scan" | "final", action: () => Promise<void>) {
  const db = w.ctx.db; let activeReads = 0;
  w.ctx.db = new Proxy(db, { get(target, field) {
    if (field !== "prepare") { const v = Reflect.get(target, field); return typeof v === "function" ? v.bind(target) : v; }
    return (sql: string) => {
      const stmt = target.prepare(sql);
      const matches = at === "scan" ? sql.includes("JOIN meta own") : sql.includes("JOIN tenant t ON t.id = am.tenant_id");
      if (!matches) return stmt;
      return new Proxy(stmt, { get(s, f) {
        if (f !== "bind") { const v = Reflect.get(s, f); return typeof v === "function" ? v.bind(s) : v; }
        return (...args: unknown[]) => {
          const bound = s.bind(...args);
          return new Proxy(bound, { get(b, method) {
            if (method === "all" && at === "scan") return async () => { const result = await b.all(); await action(); return result; };
            if (method === "first" && at === "final") return async () => { if (++activeReads === 2) await action(); return b.first(); };
            const v = Reflect.get(b, method); return typeof v === "function" ? v.bind(b) : v;
          } });
        };
      } });
    };
  } });
}

function changeAfterPreference(w: World, action: () => Promise<void>) {
  const db = w.ctx.db; let fired = false;
  w.ctx.db = new Proxy(db, { get(target, field) {
    if (field !== "prepare") { const v = Reflect.get(target, field); return typeof v === "function" ? v.bind(target) : v; }
    return (sql: string) => {
      const stmt = target.prepare(sql);
      if (sql !== "SELECT value FROM meta WHERE key = ?") return stmt;
      return new Proxy(stmt, { get(s, field) {
        if (field !== "bind") { const v = Reflect.get(s, field); return typeof v === "function" ? v.bind(s) : v; }
        return (...args: unknown[]) => {
          const bound = s.bind(...args);
          if (args[0] !== w.prefKey) return bound;
          return new Proxy(bound, { get(b, method) {
            if (method === "first") return async () => { const r = await b.first(); if (!fired) { fired = true; await action(); } return r; };
            const v = Reflect.get(b, method); return typeof v === "function" ? v.bind(b) : v;
          } });
        };
      } });
    };
  } });
}

describe("bounded own human response agenda", () => {
  it.each([false, true])("shows org/project=%s own outstanding intention metadata, with no effects or reply data", async project => {
    const w = await world(project);
    expect(await responseAgenda(w.ctx)).toMatchObject({ entries: [], scanned: 0, has_more: false, next_before: null });
    await setResponseIntent(w.ctx, w.id, "planned", 0, w.ctx.now + 60_000);
    const before = await snapshot();
    const agenda = await responseAgenda(w.ctx);
    expect(agenda).toMatchObject({ entries: [{ mail_id: w.id, state: "planned", revision: 1, can_plan: true, respond_by: w.ctx.now + 60_000 }], scanned: 1,
      notification: "not_requested", automatic_execution: "not_implemented", response_guaranteed: false, order: "mail_id_desc_not_deadline_priority" });
    expect(Object.keys(agenda.entries[0]!).sort()).toEqual(["can_plan", "mail_id", "respond_by", "revision", "state", "updated_at"]);
    expect(await snapshot()).toEqual(before);
    expect((await api(w)).status).toBe(200);
    expect((await api(w, {}, cookieHeaders(w.other.token, host))).status).toBe(200);
    expect((await (await api(w, {}, cookieHeaders(w.other.token, host))).json() as any).result.entries).toEqual([]);
    expect((await (await api(w, {}, cookieHeaders(w.admin.token, host))).json() as any).result.entries).toEqual([]);
  });
  it.each(["planned", "overdue", "stale", "untimed"])("reports %s without inferring fulfillment or writing", async state => {
    const w = await world();
    await storedIntent(w, "planned", state === "untimed" ? null : state === "overdue" ? w.ctx.now - 1 : w.ctx.now + 10_000);
    if (state === "stale") await env.HUB_DB.prepare("UPDATE meta SET value = '{}' WHERE key = ?").bind(w.prefKey).run();
    const before = await snapshot();
    expect((await responseAgenda(w.ctx)).entries[0]!.state).toBe(state === "untimed" ? "planned" : state);
    expect(await snapshot()).toEqual(before);
  });
  it.each(["cancelled", "completed", "invalid", "unset"])("omits %s own record without resetting or exposure", async state => {
    const w = await world();
    if (state !== "unset") await storedIntent(w, state === "invalid" ? "sent" : state);
    const before = await snapshot();
    expect((await responseAgenda(w.ctx)).entries).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
  it.each(["proof", "pending", "private", "released", "quarantined", "foreign", "source"])("does not expose %s source/proof details", async change => {
    const w = await world(); await storedIntent(w);
    if (change === "proof") await env.HUB_DB.prepare("DELETE FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
    if (change === "pending") await env.HUB_DB.prepare("UPDATE meta SET value = json_set(value, '$.status', 'pending') WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
    if (change === "private") await env.HUB_DB.prepare("UPDATE inbound_mail SET recipient_id = ? WHERE id = ?").bind(w.bot.agent.identity.id, w.id).run();
    if (change === "released") await env.HUB_DB.prepare("UPDATE inbound_mail SET released_by = ? WHERE id = ?").bind(w.admin.identity.id, w.id).run();
    if (change === "quarantined") await env.HUB_DB.prepare("UPDATE inbound_mail SET verdict = 'quarantined' WHERE id = ?").bind(w.id).run();
    if (change === "foreign") await env.HUB_DB.prepare("UPDATE inbound_mail SET tenant_id = ? WHERE id = ?").bind(w.foreign.id, w.id).run();
    if (change === "source") await env.HUB_DB.prepare("UPDATE inbound_mail SET message_id = '<changed@example.com>' WHERE id = ?").bind(w.id).run();
    const agenda = await responseAgenda(w.ctx);
    expect(agenda.entries).toEqual([]); expect(agenda.next_before).toBeNull();
    const html = await (await SELF.fetch(`https://${host}/mail/agenda`, { headers: w.headers })).text();
    expect(html).not.toContain(w.id);
  });
  it("continues through an empty page of terminal records to older outstanding intentions", async () => {
    const w = await world(); await storedIntent(w);
    const ids = [];
    for (let i = 1; i <= RESPONSE_AGENDA_SCAN; i++) ids.push(await cloneSource(w, i, "completed"));
    const before = await snapshot();
    const first = await responseAgenda(w.ctx);
    expect(first).toMatchObject({ entries: [], scanned: RESPONSE_AGENDA_SCAN, has_more: true, next_before: ids[0] });
    const second = await responseAgenda(w.ctx, first.next_before);
    expect(second).toMatchObject({ entries: [{ mail_id: w.id }], scanned: 1, has_more: false, next_before: null });
    expect(await snapshot()).toEqual(before);
    const html = await (await SELF.fetch(`https://${host}/mail/agenda`, { headers: w.headers })).text();
    expect(html).toContain(`before=${ids[0]}`); expect(html).toContain("No outstanding intentions in this scan page");
  });
  it("caps work, orders by mail ID (not due time), and never returns an unscanned continuation row", async () => {
    const w = await world(); await storedIntent(w);
    const ids = [];
    for (let i = 1; i <= RESPONSE_AGENDA_SCAN + 2; i++) ids.push(await cloneSource(w, i));
    const first = await responseAgenda(w.ctx);
    expect(first.entries.map(e => e.mail_id)).toEqual(ids.slice(2).reverse());
    expect(first.scanned).toBe(RESPONSE_AGENDA_SCAN);
    const second = await responseAgenda(w.ctx, first.next_before);
    expect(second.entries.map(e => e.mail_id)).toEqual([ids[1], ids[0], w.id]);
    expect(second.has_more).toBe(false);
  });
  it.each(["removed", "reader", "root", "archived", "tenant"])("fails %s authority even on empty scan, not a fabricated empty agenda", async change => {
    const w = await world();
    if (["removed", "root"].includes(change)) await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ?").bind(w.member.identity.id).run();
    if (change === "root") await env.HUB_DB.prepare("UPDATE identity SET is_root = 1 WHERE id = ?").bind(w.member.identity.id).run();
    if (change === "reader") await env.HUB_DB.prepare("UPDATE membership SET role = 'reader' WHERE identity_id = ?").bind(w.member.identity.id).run();
    if (change === "archived") await env.HUB_DB.prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(w.member.identity.id).run();
    if (change === "tenant") await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(w.tenant.id).run();
    await expect(responseAgenda(w.ctx)).rejects.toMatchObject({ reason: "not_found" });
  });
  it.each([false, true])("fails loss of final authority for populated=%s scan", async populated => {
    const w = await world(); if (populated) await storedIntent(w);
    interleave(w, "final", async () => { await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ?").bind(w.member.identity.id).run(); });
    await expect(responseAgenda(w.ctx)).rejects.toMatchObject({ reason: "not_found" });
  });
  it("rechecks source after scan and omits a now-private candidate", async () => {
    const w = await world(); await storedIntent(w);
    interleave(w, "scan", async () => { await env.HUB_DB.prepare("UPDATE inbound_mail SET recipient_id = ? WHERE id = ?").bind(w.bot.agent.identity.id, w.id).run(); });
    expect((await responseAgenda(w.ctx)).entries).toEqual([]);
  });
  it.each(["source", "preferences", "intent", "proof"])("refuses whole agenda on %s change after per-entry observation, not partial stale output", async change => {
    const w = await world(); await storedIntent(w);
    changeAfterPreference(w, async () => {
      if (change === "source") await env.HUB_DB.prepare("UPDATE inbound_mail SET recipient_id = ? WHERE id = ?").bind(w.bot.agent.identity.id, w.id).run();
      if (change === "preferences") await env.HUB_DB.prepare("UPDATE meta SET value = '{}' WHERE key = ?").bind(w.prefKey).run();
      if (change === "intent") await env.HUB_DB.prepare("DELETE FROM meta WHERE key = ?").bind(w.key).run();
      if (change === "proof") await env.HUB_DB.prepare("DELETE FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
    });
    await expect(responseAgenda(w.ctx)).rejects.toMatchObject({ reason: "conflict" });
  });
  it("renders a conflict/reload page without intention links or details", async () => {
    const w = await world(); await storedIntent(w);
    changeAfterPreference(w, async () => { await env.HUB_DB.prepare("UPDATE meta SET value = '{}' WHERE key = ?").bind(w.prefKey).run(); });
    const r = await mailAgendaPage(new Request(`https://${host}/mail/agenda`, { headers: w.headers }), { ...env, HUB_DB: w.ctx.db });
    expect(r.status).toBe(409); expect(r.headers.get("cache-control")).toContain("no-store");
    const html = await r.text(); expect(html).toContain("Reload to reconcile"); expect(html).not.toContain(w.id);
  });
  it("disables outbound comparison while retaining final per-entry authority checks", async () => {
    const w = await world(); await storedIntent(w);
    const db = w.ctx.db; const modes: unknown[] = [];
    w.ctx.db = new Proxy(db, { get(target, field) {
      if (field !== "prepare") { const v = Reflect.get(target, field); return typeof v === "function" ? v.bind(target) : v; }
      return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!sql.includes("LEFT JOIN outbound_mail")) return stmt;
        return new Proxy(stmt, { get(s, method) {
          if (method === "bind") return (...args: unknown[]) => { modes.push(args[0]); return s.bind(...args); };
          const v = Reflect.get(s, method); return typeof v === "function" ? v.bind(s) : v;
        } });
      };
    } });
    expect((await responseAgenda(w.ctx)).entries).toHaveLength(1); expect(modes).toEqual([0]);
  });
  it("does not swallow database failures as a successful empty agenda", async () => {
    const w = await world(); await storedIntent(w);
    interleave(w, "scan", async () => { throw new Error("unavailable database"); });
    await expect(responseAgenda(w.ctx)).rejects.toThrow("unavailable database");
  });
  it("is human-only/non-MCP, enforces Origin/tenant/auth, and does not require fresh proof to read", async () => {
    const w = await world();
    for (const headers of [{}, cookieHeaders(w.reader.token, host), bearer(w.bot.token), { ...w.headers, origin: "https://evil.test" }]) expect((await api(w, {}, headers)).status).not.toBe(200);
    expect((await apiPost("foreign.pimwell.test", "mail.response_agenda", {}, cookieHeaders(w.member.token, "foreign.pimwell.test"))).status).not.toBe(200);
    const verb = getVerb("mail.response_agenda")!; expect(verb.mcp).toBeUndefined();
    const botCtx = await buildContext(new Request(`https://${host}/api/mail.response_agenda`, { headers: bearer(w.bot.token) }), env);
    expect(() => checkAccess({ ...botCtx, role: "admin" }, verb)).toThrow("agents may not");
    for (const headers of [{}, cookieHeaders(w.reader.token, host), bearer(w.bot.token)]) expect((await SELF.fetch(`https://${host}/mail/agenda`, { headers })).status).toBe(404);
    await env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, w.member.session.id).run();
    expect((await api(w)).status).toBe(200);
    expect((await SELF.fetch(`https://${host}/mail/agenda`, { headers: w.headers })).status).toBe(200);
  });
  it.each(["bad", "<script>", "x".repeat(27), 12])("rejects malformed scan cursor %s", async before => {
    const w = await world(); expect((await api(w, { before })).status).toBe(400);
    expect((await SELF.fetch(`https://${host}/mail/agenda?before=${encodeURIComponent(String(before))}`, { headers: w.headers })).status).toBe(404);
  });
  it("renders metadata-only UTC deadlines and explicit coverage, no mail content, controls or delivery claims", async () => {
    const w = await world(); await storedIntent(w, "planned", w.ctx.now + 60_000);
    await env.HUB_DB.prepare("UPDATE inbound_mail SET subject = '<script>secret subject</script>', text = 'secret body' WHERE id = ?").bind(w.id).run();
    const before = await snapshot();
    const r = await SELF.fetch(`https://${host}/mail/agenda`, { headers: w.headers });
    expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toContain("no-store");
    const html = await r.text();
    expect(html).toContain(`/mail/${w.id}`); expect(html).toContain(new Date(w.ctx.now + 60_000).toISOString());
    expect(html).toContain("not deadline priority"); expect(html).toContain("sends no notifications");
    expect(html).not.toContain("secret subject"); expect(html).not.toContain("secret body");
    expect(html).not.toContain('action="/api/mail.set_response_intent"');
    expect(await snapshot()).toEqual(before);
    expect(await (await SELF.fetch(`https://${host}/mail`, { headers: w.headers })).text()).toContain('href="/mail/agenda"');
  });
});
