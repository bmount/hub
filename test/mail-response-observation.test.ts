import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fixtures from "./fixtures/dkim.json";
import { registerAllVerbs } from "../src/verbs/index";
import { mailReply } from "../src/verbs/mailOut";
import { buildContext } from "../src/auth/context";
import { storeIndependentMailCandidate, REPLAY_PREFIX } from "../src/mail/replay";
import { RESPONSE_INTENT_PREFIX, responseIntent, setResponseIntent } from "../src/mail/responseIntent";
import { RESPONSE_RECIPIENT_PREFIX } from "../src/mail/responseRecipients";
import { setTestTransport } from "../src/mail/send";
import { grantConsent } from "../src/db/consent";
import { createProject } from "../src/db/projects";
import { ulid } from "../src/ids";
import { mailIntentPanel } from "../src/http/mailIntentPanel";
import { apiPost, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const host = "observed.pimwell.test";
const now = Date.parse(fixtures.now) + 120_000;
beforeAll(registerAllVerbs);
afterEach(() => setTestTransport(null));
async function world(projectMail = false) {
  const tenant = await seedTenant("observed"), foreign = await seedTenant("foreign");
  const member = await seedHuman("member@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const other = await seedHuman("other@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: tenant.id, role: "admin" }] });
  const bot = await seedAgent(tenant, admin.identity);
  const project = await createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug: "site", display_name: "Site", kind: "tracker" }, now);
  const to = projectMail ? "observed.site@pimwell.test" : "observed@pimwell.test";
  const stored = await storeIndependentMailCandidate(env, { bytes: new TextEncoder().encode(fixtures.valid), from: member.identity.email, to }, now, async () => [[fixtures.record]]);
  if (stored.status !== "stored") throw new Error("signed fixture was not stored");
  const headers = cookieHeaders(member.token, host);
  expect((await apiPost(host, "mail.set_response_recipients", { address: to, recipients: [member.identity.id, other.identity.id], expected_revision: 0 }, cookieHeaders(admin.token, host))).status).toBe(200);
  const ctx = await buildContext(new Request(`https://${host}/api/mail.response_intent`, { headers }), env);
  ctx.now = now + 60_000;
  await setResponseIntent(ctx, stored.mail_id, "planned", 0);
  return { tenant, foreign, member, other, admin, bot, project, to, id: stored.mail_id, headers, ctx,
    key: `${RESPONSE_INTENT_PREFIX}${tenant.id}:${stored.mail_id}:${member.identity.id}`,
    prefKey: `${RESPONSE_RECIPIENT_PREFIX}${tenant.id}:${projectMail ? project.id : "org"}` };
}
type World = Awaited<ReturnType<typeof world>>;
async function attempt(w: World, patch: Partial<{ id: string; tenant_id: string; sent_by: string; in_reply_to: string | null;
  from_address: string; to_address: string; status: string; created_at: number }> = {}) {
  const a = { id: ulid(w.ctx.now), tenant_id: w.tenant.id, sent_by: w.member.identity.id, in_reply_to: w.id,
    from_address: w.to, to_address: w.member.identity.email, status: "sent", created_at: w.ctx.now, ...patch };
  await env.HUB_DB.prepare(`INSERT INTO outbound_mail
    (id, tenant_id, sent_by, in_reply_to, from_address, to_address, status, created_at, subject, text, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PRIVATE SUBJECT', 'PRIVATE BODY', 'PRIVATE ERROR')`)
    .bind(a.id, a.tenant_id, a.sent_by, a.in_reply_to, a.from_address, a.to_address, a.status, a.created_at).run();
  return a.id;
}
const observe = async (w: World) => (await responseIntent(w.ctx, w.id)).reply_observation;

// Interleave AFTER preferences have been observed, not only when an outbound
// query happens: the old implementation skipped that query for terminal states.
function afterPreferenceRead(w: World, change: () => Promise<void>) {
  const db = w.ctx.db;
  let fired = false;
  w.ctx.db = new Proxy(db, { get(target, key) {
    if (key !== "prepare") { const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v; }
    return (sql: string) => {
      const stmt = target.prepare(sql);
      if (sql !== "SELECT value FROM meta WHERE key = ?") return stmt;
      return new Proxy(stmt, { get(s, key) {
        if (key !== "bind") { const v = Reflect.get(s, key); return typeof v === "function" ? v.bind(s) : v; }
        return (...args: unknown[]) => {
          const bound = s.bind(...args);
          return new Proxy(bound, { get(b, key) {
            if (key !== "first" || args[0] !== w.prefKey) { const v = Reflect.get(b, key); return typeof v === "function" ? v.bind(b) : v; }
            return async () => {
              const result = await bound.first();
              if (!fired) { fired = true; await change(); }
              return result;
            };
          } });
        };
      } });
    };
  } });
}

describe("all-state intention read snapshots and control eligibility", () => {
  const states = ["unset", "invalid", "cancelled", "completed", "planned"] as const;
  async function atState(state: typeof states[number], project = false) {
    const w = await world(project);
    if (state === "unset") await env.HUB_DB.prepare("DELETE FROM meta WHERE key = ?").bind(w.key).run();
    if (state === "invalid") await env.HUB_DB.prepare("UPDATE meta SET value = '{}' WHERE key = ?").bind(w.key).run();
    if (state === "cancelled" || state === "completed") await setResponseIntent(w.ctx, w.id, state, 1);
    await attempt(w);
    return w;
  }
  it.each(states)("revalidates %s without outbound or other read effects", async state => {
    const w = await atState(state);
    const tables = ["meta", "event", "inbound_mail", "outbound_mail", "consent", "attention", "membership", "oauth_grant"];
    const snapshot = async () => (await env.HUB_DB.batch(tables.map(t => env.HUB_DB.prepare(`SELECT * FROM ${t}`)))).map(r => r.results);
    const before = await snapshot();
    for (let n = 0; n < 3; n++) {
      const r = await responseIntent(w.ctx, w.id);
      expect(r.state).toBe(state);
      expect(r.reply_observation.state).toBe(state === "planned" ? "transport_accepted" : "not_applicable");
      expect(r.reply_observation.outbound_id === null).toBe(state !== "planned");
      expect(r.response_guaranteed).toBe(false);
    }
    expect(await snapshot()).toEqual(before);
  });
  it.each(states.flatMap(state => ["member", "identity", "tenant", "private", "released", "source", "replay", "intent", "preferences"].map(change => ({ state, change }))))(
    "refuses obsolete $state state after $change changes during read", async ({ state, change }) => {
      const w = await atState(state);
      afterPreferenceRead(w, async () => {
        if (change === "member") await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ?").bind(w.member.identity.id).run();
        if (change === "identity") await env.HUB_DB.prepare("UPDATE identity SET state = 'disabled' WHERE id = ?").bind(w.member.identity.id).run();
        if (change === "tenant") await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(w.tenant.id).run();
        if (change === "private") await env.HUB_DB.prepare("UPDATE inbound_mail SET recipient_id = ? WHERE id = ?").bind(w.bot.agent.identity.id, w.id).run();
        if (change === "released") await env.HUB_DB.prepare("UPDATE inbound_mail SET released_by = ? WHERE id = ?").bind(w.admin.identity.id, w.id).run();
        if (change === "source") await env.HUB_DB.prepare("UPDATE inbound_mail SET to_address = 'changed@pimwell.test' WHERE id = ?").bind(w.id).run();
        if (change === "replay") await env.HUB_DB.prepare("DELETE FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
        if (change === "intent") {
          // Includes absent -> inserted, invalid -> replaced and terminal -> replaced.
          await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, '{}') ON CONFLICT(key) DO UPDATE SET value = 'changed'").bind(w.key).run();
        }
        if (change === "preferences") await env.HUB_DB.prepare("DELETE FROM meta WHERE key = ?").bind(w.prefKey).run();
      });
      await expect(responseIntent(w.ctx, w.id)).rejects.toThrow("reply evidence changed");
    });
  it.each([false, true].flatMap(project => states.map(state => ({ project, state }))))(
    "rechecks org/project=$project address availability for $state", async ({ project, state }) => {
      const w = await atState(state, project);
      afterPreferenceRead(w, async () => {
        await env.HUB_DB.prepare(project ? "UPDATE project SET state = 'archived' WHERE id = ?" : "UPDATE tenant SET slug = 'renamed' WHERE id = ?")
          .bind(project ? w.project.id : w.tenant.id).run();
      });
      await expect(responseIntent(w.ctx, w.id)).rejects.toThrow("reply evidence changed");
      const fresh = await responseIntent(w.ctx, w.id);
      expect(fresh.can_plan).toBe(false);
      expect(fresh.state).toBe(state === "planned" ? "stale" : state);
      if (state === "completed") expect(fresh.completion_evidence).toBe("self_reported");
    });
  it.each(["unset", "empty", "invalid", "unselected"])("refuses a changed %s preference snapshot, including absent -> inserted", async pref => {
    const w = await atState("unset");
    const selected = await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(w.prefKey).first<string>("value");
    if (pref === "unset") await env.HUB_DB.prepare("DELETE FROM meta WHERE key = ?").bind(w.prefKey).run();
    else {
      const value = pref === "invalid" ? "{}" : JSON.stringify({ ...JSON.parse(selected!), recipients: pref === "empty" ? [] : [w.other.identity.id] });
      await env.HUB_DB.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(value, w.prefKey).run();
    }
    afterPreferenceRead(w, async () => { await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(w.prefKey, selected).run(); });
    await expect(responseIntent(w.ctx, w.id)).rejects.toThrow("reply evidence changed");
    expect((await responseIntent(w.ctx, w.id)).can_plan).toBe(true);
  });
  it("refuses a pane rather than rendering obsolete completion or plan controls", async () => {
    const w = await atState("completed");
    afterPreferenceRead(w, async () => { await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ?").bind(w.member.identity.id).run(); });
    await expect(mailIntentPanel(w.ctx, w.id)).rejects.toThrow("reply evidence changed");
  });
  it("detects destination restoration, while stable unselected or archived snapshots stay readable", async () => {
    const w = await atState("cancelled", true);
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.project.id).run();
    expect(await responseIntent(w.ctx, w.id)).toMatchObject({ state: "cancelled", can_plan: false });
    afterPreferenceRead(w, async () => { await env.HUB_DB.prepare("UPDATE project SET state = 'active' WHERE id = ?").bind(w.project.id).run(); });
    await expect(responseIntent(w.ctx, w.id)).rejects.toThrow("reply evidence changed");
    expect(await responseIntent(w.ctx, w.id)).toMatchObject({ state: "cancelled", can_plan: true });
    await env.HUB_DB.prepare("DELETE FROM meta WHERE key = ?").bind(w.prefKey).run();
    expect(await responseIntent(w.ctx, w.id)).toMatchObject({ state: "cancelled", can_plan: false });
  });
});

describe("bounded own reply-record observations, not delivery or intention fulfillment", () => {
  it.each([false, true])("observes org/project=%s transport acceptance without completing intent or any write", async project => {
    const w = await world(project), id = await attempt(w);
    const before = await env.HUB_DB.batch(["meta", "event", "inbound_mail", "outbound_mail", "consent", "attention", "membership", "oauth_grant"].map(t => env.HUB_DB.prepare(`SELECT * FROM ${t}`)));
    const result = await responseIntent(w.ctx, w.id);
    expect(result).toMatchObject({ state: "planned", revision: 1, response_guaranteed: false, notification: "not_requested",
      reply_observation: { state: "transport_accepted", outbound_id: id, recorded_at: w.ctx.now,
        recipient_delivery: "not_observed", fulfillment: "not_inferred", coverage: "latest_recorded_matching_own_reply_since_revision_time" } });
    const encoded = JSON.stringify(result);
    for (const secret of ["PRIVATE SUBJECT", "PRIVATE BODY", "PRIVATE ERROR", w.member.identity.email, w.to]) expect(encoded).not.toContain(secret);
    const after = await env.HUB_DB.batch(["meta", "event", "inbound_mail", "outbound_mail", "consent", "attention", "membership", "oauth_grant"].map(t => env.HUB_DB.prepare(`SELECT * FROM ${t}`)));
    expect(after.map(r => r.results)).toEqual(before.map(r => r.results));
  });
  it.each(["failed", "refused"])("reports stored %s without claiming delivery or definite non-send", async status => {
    const w = await world(), id = await attempt(w, { status });
    expect(await observe(w)).toMatchObject({ state: status === "refused" ? "consent_refused" : "outcome_unknown", outbound_id: id,
      recipient_delivery: "not_observed", fulfillment: "not_inferred" });
    expect((await responseIntent(w.ctx, w.id)).state).toBe("planned");
  });
  it("does not equate absence with no send and does not populate intent from reply evidence", async () => {
    const w = await world();
    expect(await observe(w)).toMatchObject({ state: "no_record", outbound_id: null, recorded_at: null });
    await attempt(w);
    await env.HUB_DB.prepare("DELETE FROM meta WHERE key = ?").bind(w.key).run();
    expect(await responseIntent(w.ctx, w.id)).toMatchObject({ state: "unset", revision: 0, reply_observation: { state: "not_applicable", outbound_id: null } });
  });
  it.each(["actor", "tenant", "unlinked", "other_mail", "from", "to", "cc", "before"])("does not expose %s mismatched reply evidence", async mismatch => {
    const w = await world();
    const patch: Parameters<typeof attempt>[1] = {};
    if (mismatch === "actor") patch.sent_by = w.other.identity.id;
    if (mismatch === "tenant") patch.tenant_id = w.foreign.id;
    if (mismatch === "unlinked") patch.in_reply_to = null;
    if (mismatch === "other_mail") {
      const id = ulid(now);
      await env.HUB_DB.prepare(`INSERT INTO inbound_mail (id, tenant_id, identity_id, from_email, to_address, received_at, size, verdict, subject, text, attachments, forwarded)
        VALUES (?, ?, ?, 'member@example.com', ?, ?, 1, 'admitted', 'other', 'other', '[]', 0)`).bind(id, w.tenant.id, w.member.identity.id, w.to, now).run();
      patch.in_reply_to = id;
    }
    if (mismatch === "from") patch.from_address = "observed.other@pimwell.test";
    if (mismatch === "to") patch.to_address = "other@example.com";
    if (mismatch === "cc") patch.to_address = "member@example.com, other@example.com";
    if (mismatch === "before") patch.created_at = w.ctx.now - 1;
    const id = await attempt(w, patch);
    expect(await observe(w)).toMatchObject({ state: "no_record", outbound_id: null });
    expect(JSON.stringify(await responseIntent(w.ctx, w.id))).not.toContain(id);
  });
  it("admin and other responders see only their own intention/attempts", async () => {
    const w = await world(), id = await attempt(w);
    for (const human of [w.admin, w.other]) {
      const ctx = await buildContext(new Request(`https://${host}/api/mail.response_intent`, { headers: cookieHeaders(human.token, host) }), env);
      ctx.now = w.ctx.now;
      if (human === w.other) await setResponseIntent(ctx, w.id, "planned", 0);
      const result = await responseIntent(ctx, w.id);
      expect(result.reply_observation.state).toBe(human === w.other ? "no_record" : "not_applicable");
      expect(JSON.stringify(result)).not.toContain(id);
    }
  });
  it("latest failed attempt does not become sent because an older one was accepted; equal-time selection is stable", async () => {
    const w = await world();
    const earlier = await attempt(w, { id: "01M4AF980SG4A68Q7VNA21WX90" });
    const later = await attempt(w, { id: "01M4AF980SG4A68Q7VNA21WX91", status: "failed" });
    expect(await observe(w)).toMatchObject({ state: "outcome_unknown", outbound_id: later });
    expect(JSON.stringify(await observe(w))).not.toContain(earlier);
    w.ctx.now += 1;
    const newest = await attempt(w);
    expect(await observe(w)).toMatchObject({ state: "transport_accepted", outbound_id: newest });
  });
  it("retiming advances the observation range; cancellation has no current planned revision; replan does not revive old replies", async () => {
    const w = await world(); await attempt(w);
    w.ctx.now += 1;
    await setResponseIntent(w.ctx, w.id, "planned", 1, w.ctx.now + 60_000);
    expect(await observe(w)).toMatchObject({ state: "no_record" });
    await setResponseIntent(w.ctx, w.id, "cancelled", 2);
    expect(await observe(w)).toMatchObject({ state: "not_applicable" });
    await setResponseIntent(w.ctx, w.id, "planned", 3);
    expect(await observe(w)).toMatchObject({ state: "no_record" });
  });
  it.each(["stale", "overdue"])("keeps %s intention state distinct from an accepted attempt", async state => {
    const w = await world();
    if (state === "overdue") {
      await setResponseIntent(w.ctx, w.id, "planned", 1, w.ctx.now + 60_000);
      w.ctx.now += 60_000;
    } else await env.HUB_DB.prepare("UPDATE meta SET value = '{}' WHERE key = ?").bind(w.prefKey).run();
    await attempt(w);
    expect(await responseIntent(w.ctx, w.id)).toMatchObject({ state, reply_observation: { state: "transport_accepted", fulfillment: "not_inferred" } });
  });
  it.each(["id", "future", "fraction", "date"])("does not render corrupt %s as accepted transport evidence", async corrupt => {
    const w = await world();
    await attempt(w, corrupt === "id" ? { id: '<img src=x onerror="evil()">' }
      : { created_at: corrupt === "future" ? w.ctx.now + 1 : corrupt === "fraction" ? w.ctx.now + 0.5 : Date.UTC(10000, 0, 1) });
    expect(await observe(w)).toMatchObject({ state: "outcome_unknown", outbound_id: null, recorded_at: null });
  });
  it.each(["released", "private", "replay", "membership", "intent", "source"])("rechecks %s before returning reply evidence", async change => {
    const w = await world(); await attempt(w);
    const db = w.ctx.db;
    w.ctx.db = new Proxy(db, { get(target, key) {
      if (key !== "prepare") { const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v; }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("LEFT JOIN outbound_mail")) return statement;
        return new Proxy(statement, { get(s, k) {
          if (k === "bind") return (...args: unknown[]) => {
            const bound = s.bind(...args);
            return new Proxy(bound, { get(b, field) {
              if (field !== "first") { const v = Reflect.get(b, field); return typeof v === "function" ? v.bind(b) : v; }
              return async () => {
                if (change === "released") await env.HUB_DB.prepare("UPDATE inbound_mail SET released_by = ? WHERE id = ?").bind(w.admin.identity.id, w.id).run();
                if (change === "private") await env.HUB_DB.prepare("UPDATE inbound_mail SET recipient_id = ? WHERE id = ?").bind(w.bot.agent.identity.id, w.id).run();
                if (change === "replay") await env.HUB_DB.prepare("DELETE FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
                if (change === "membership") await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ?").bind(w.member.identity.id).run();
                if (change === "intent") await env.HUB_DB.prepare("DELETE FROM meta WHERE key = ?").bind(w.key).run();
                if (change === "source") await env.HUB_DB.prepare("UPDATE inbound_mail SET to_address = 'changed@pimwell.test' WHERE id = ?").bind(w.id).run();
                return bound.first();
              };
            } });
          };
          const v = Reflect.get(s, k); return typeof v === "function" ? v.bind(s) : v;
        } });
      };
    } });
    await expect(observe(w)).rejects.toThrow("reply evidence changed");
  });
  it.each(["sent", "failed", "refused"])("observes an actual mail.reply %s fixture without completing intention or resending", async status => {
    const w = await world(true);
    await env.HUB_DB.prepare("UPDATE tenant SET mail_out = 1 WHERE id = ?").bind(w.tenant.id).run();
    await grantConsent(env.HUB_DB, { email: w.member.identity.email, kind: "inbound_email", source_message_id: null, evidence: null }, Date.now());
    if (status === "refused") await env.HUB_DB.prepare("UPDATE consent SET revoked_at = ?").bind(Date.now()).run();
    let calls = 0;
    setTestTransport(async () => { calls++; if (status === "failed") throw new Error("PRIVATE TRANSPORT ERROR"); });
    const result = await apiPost(host, "mail.reply", { id: w.id, body: "A reply fixture, not a live send" }, w.headers);
    expect(result.status).toBe(status === "sent" ? 200 : status === "failed" ? 502 : 403);
    w.ctx.now = Date.now();
    const current = await responseIntent(w.ctx, w.id);
    expect(current).toMatchObject({ state: "planned", revision: 1, reply_observation: {
      state: status === "sent" ? "transport_accepted" : status === "refused" ? "consent_refused" : "outcome_unknown" } });
    expect(calls).toBe(status === "refused" ? 0 : 1);
    await observe(w); await observe(w);
    expect(calls).toBe(status === "refused" ? 0 : 1);
    expect(JSON.stringify(current)).not.toContain("PRIVATE TRANSPORT ERROR");
  });
  it("reports no_record when transport accepted but post-send recording failed, without resending or inferring unsent", async () => {
    const w = await world(true);
    await env.HUB_DB.prepare("UPDATE tenant SET mail_out = 1 WHERE id = ?").bind(w.tenant.id).run();
    await grantConsent(env.HUB_DB, { email: w.member.identity.email, kind: "inbound_email", source_message_id: null, evidence: null }, now);
    let calls = 0;
    setTestTransport(async () => { calls++; });
    const original = w.ctx.db;
    const sendingCtx = { ...w.ctx, db: new Proxy(original, { get(db, key) {
      if (key !== "prepare") { const v = Reflect.get(db, key); return typeof v === "function" ? v.bind(db) : v; }
      return (sql: string) => {
        if (sql.includes("INSERT INTO outbound_mail")) throw new Error("post-send storage unavailable");
        return db.prepare(sql);
      };
    } }) };
    await expect(mailReply.run(sendingCtx, mailReply.parse({ id: w.id, body: "fixture reply" }))).rejects.toThrow("post-send storage unavailable");
    expect(calls).toBe(1);
    expect(await observe(w)).toMatchObject({ state: "no_record", recipient_delivery: "not_observed", fulfillment: "not_inferred" });
    expect(calls).toBe(1);
    expect((await responseIntent(w.ctx, w.id)).state).toBe("planned");
  });
  it("invalid intentions reveal no attempt and cannot be reset through a delivery claim", async () => {
    const w = await world(), id = await attempt(w);
    await env.HUB_DB.prepare("UPDATE meta SET value = '{}' WHERE key = ?").bind(w.key).run();
    const current = await responseIntent(w.ctx, w.id);
    expect(current).toMatchObject({ state: "invalid", revision: null, reply_observation: { state: "not_applicable", outbound_id: null } });
    expect(JSON.stringify(current)).not.toContain(id);
    expect((await apiPost(host, "mail.set_response_intent", { id: w.id, state: "sent", expected_revision: 1 }, w.headers)).status).toBe(400);
  });
  it("renders truthful latest own evidence, invalidates pane key and keeps content/errors out of the observation panel", async () => {
    const w = await world();
    const page = async () => {
      const r = await SELF.fetch(`https://${host}/mail/${w.id}`, { headers: w.headers });
      expect(r.headers.get("cache-control")).toBe("no-store");
      return r.text();
    };
    const before = await page();
    expect(before).toContain("does not prove that no mail was sent");
    const id = await attempt(w);
    const after = await page();
    expect(after).toContain("transport acceptance, not recipient delivery");
    expect(after).toContain(id);
    expect(after).toContain("no intention is automatically completed");
    // Existing canonical reply rendering may show readable outbound bodies. The
    // new observation panel returns metadata only, not copies of those bodies.
    const panel = await mailIntentPanel(w.ctx, w.id);
    for (const secret of ["PRIVATE SUBJECT", "PRIVATE BODY", "PRIVATE ERROR"]) expect(panel.html).not.toContain(secret);
    const paneKey = (html: string) => html.match(/id="inspector"[^>]*data-key="([^"]*)"/)![1];
    expect(paneKey(after)).not.toBe(paneKey(before));
    await env.HUB_DB.prepare("UPDATE outbound_mail SET status = 'failed' WHERE id = ?").bind(id).run();
    const failed = await page();
    expect(failed).toContain("Do not infer that nothing was sent or blindly retry");
    expect(paneKey(failed)).not.toBe(paneKey(after));
  });
});
