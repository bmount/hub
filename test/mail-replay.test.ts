import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixtures from "./fixtures/dkim.json";
import { seedAgent, seedHuman, seedTenant } from "./helpers";
import { storeIndependentMailCandidate, REPLAY_PREFIX } from "../src/mail/replay";
import { createProject } from "../src/db/projects";
import { deleteTenant } from "../src/db/tenantDelete";
import { grantConsent, revokeConsent } from "../src/db/consent";
import * as delivery from "../src/mail/send";
import { sha256Hex, ulid } from "../src/ids";
import type { Env } from "../src/env";

const now = Date.parse(fixtures.now) + 120_000;
const from = "member@example.com", to = "replaytest@pimwell.test";
const input = (raw = fixtures.valid, address = to, sender = from) => ({ bytes: new TextEncoder().encode(raw), from: sender, to: address });
const lookup = async () => [[fixtures.record]];
const store = (raw = fixtures.valid, address = to, sender = from, e: Env = env) => storeIndependentMailCandidate(e, input(raw, address, sender), now, lookup);
const rows = async () => (await env.HUB_DB.prepare("SELECT * FROM inbound_mail").all()).results;
const states = async () => (await env.HUB_DB.prepare("SELECT key, value FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").all<{key: string; value: string}>()).results;
async function world(root = false) {
  const tenant = await seedTenant("replaytest");
  const human = await seedHuman(from, { is_root: root, memberships: root ? [] : [{ tenant_id: tenant.id, role: "member" }] });
  return { tenant, human };
}
function wrappedBatch(batch: D1Database["batch"]): Env {
  return { ...env, HUB_DB: new Proxy(env.HUB_DB, { get(db, prop) {
    if (prop === "batch") return batch;
    const value = Reflect.get(db, prop);
    return typeof value === "function" ? value.bind(db) : value;
  } }) };
}
afterEach(() => vi.restoreAllMocks());

describe("atomic independent-proof storage candidate", () => {
  it("stores signed evidence, proof-bound Message-ID and atomic audit without sending or waking", async () => {
    const w = await world();
    const send = vi.spyOn(delivery, "sendMail");
    const r = await store(fixtures.valid, " REPLAYTEST@PIMWELL.TEST ", "MEMBER@EXAMPLE.COM");
    expect(r.status).toBe("stored");
    expect(await rows()).toEqual([expect.objectContaining({ tenant_id: w.tenant.id, identity_id: w.human.identity.id,
      from_email: from, to_address: to, message_id: "<dkim-fixture@example.com>", verdict: "admitted", reason: null,
      size: new TextEncoder().encode(fixtures.valid).length, text: "Original body.", copied: '["copied@example.com"]' })]);
    expect(JSON.parse((await states())[0]!.value)).toMatchObject({ status: "stored", raw_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(send).not.toHaveBeenCalled();
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM consent").first("n")).toBe(0);
    expect(await env.HUB_DB.prepare("SELECT kind, target_id FROM event").first()).toEqual({ kind: "mail.received", target_id: r.status === "stored" ? r.mail_id : "" });
  });

  it("atomically selects one winner for concurrent arrivals and reconciles subsequent duplicates", async () => {
    await world();
    const results = await Promise.all(Array.from({ length: 12 }, () => store()));
    expect(results.filter((r) => r.status === "stored")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(11);
    const row = (await rows())[0]!;
    expect(await store()).toMatchObject({ status: "duplicate", mail_id: row.id });
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM event WHERE kind = 'mail.received'").first("n")).toBe(1);
    expect(await rows()).toHaveLength(1);
    expect(await states()).toHaveLength(1);
  });

  it("isolates organization, project, agent and cross-tenant mailbox deliveries", async () => {
    const w = await world(true);
    const other = await seedTenant("otherreplay");
    await createProject(env.HUB_DB, { tenant_id: w.tenant.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, now);
    const bot = await seedAgent(w.tenant, w.human.identity);
    const addresses = [to, "replaytest.site@pimwell.test", bot.agent.identity.email, "otherreplay@pimwell.test"];
    for (const address of addresses) expect((await store(fixtures.valid, address)).status).toBe("stored");
    for (const address of addresses) expect((await store(fixtures.valid, address)).status).toBe("duplicate");
    expect(await rows()).toHaveLength(4);
    expect(await states()).toHaveLength(4);
    expect((await rows()).filter((r) => r.tenant_id === other.id)).toHaveLength(1);
  });

  it("blocks different valid signed bytes with the same scoped Message-ID rather than overwriting", async () => {
    await world();
    await store();
    // Same From/Message-ID and body, different genuinely valid signature.
    expect(await storeIndependentMailCandidate(env, input(fixtures.ed25519), now, async () => [[fixtures.edRecord]]))
      .toEqual({ status: "collision" });
    // Even unsigned transport additions are conservative conflicts, not a resend.
    expect(await store("Received: from untrusted.example\r\n" + fixtures.valid)).toEqual({ status: "collision" });
    expect(await rows()).toHaveLength(1);
  });

  it.each([fixtures.raw, fixtures.expired, fixtures.unsignedCc, fixtures.limitedFull,
    fixtures.valid.replace("Original body.", "Altered body."), "Message-ID: <duplicate@example.com>\r\n" + fixtures.valid,
    "From: member@example.com\r\n" + fixtures.valid])("does not reserve unknown proof %#", async (raw) => {
    await world();
    expect((await store(raw)).status).toBe("unknown");
    expect(await rows()).toHaveLength(0);
    expect(await states()).toHaveLength(0);
  });

  it("cannot reuse a member signature for a different envelope identity", async () => {
    const w = await world();
    await seedHuman("other@example.com", { memberships: [{ tenant_id: w.tenant.id, role: "member" }] });
    expect((await store(fixtures.valid, to, "other@example.com")).status).toBe("unknown");
    expect(await states()).toHaveLength(0);
  });

  it("key failures remain unknown without exposing diagnostics or reserving replay state", async () => {
    await world();
    const r = await storeIndependentMailCandidate(env, input(), now, async () => { throw new Error("private key diagnostic"); });
    expect(r.status).toBe("unknown");
    expect(JSON.stringify(r)).not.toContain("private key diagnostic");
    expect(await states()).toHaveLength(0);
  });

  it.each(["membership", "human", "tenant", "missing_mailbox"])("enforces current %s before proof or replay reads", async (scenario) => {
    await world(); await store();
    if (scenario === "membership") await env.HUB_DB.prepare("UPDATE membership SET state = 'inactive'").run();
    if (scenario === "human") await env.HUB_DB.prepare("UPDATE identity SET state = 'inactive'").run();
    if (scenario === "tenant") await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived'").run();
    const resolver = vi.fn(lookup);
    const r = await storeIndependentMailCandidate(env, input(fixtures.valid, scenario === "missing_mailbox" ? "replaytest.absent@pimwell.test" : to), now, resolver);
    expect(r).toEqual({ status: "ineligible" });
    expect(resolver).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(1);
  });

  it.each(["membership", "project", "agent"])("rechecks %s at the actual write, after verification", async (scenario) => {
    const w = await world();
    let address = to;
    if (scenario === "project") {
      await createProject(env.HUB_DB, { tenant_id: w.tenant.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, now);
      address = "replaytest.site@pimwell.test";
    }
    if (scenario === "agent") address = (await seedAgent(w.tenant, w.human.identity)).agent.identity.email;
    const db = env.HUB_DB;
    const race = wrappedBatch(async (statements) => {
      if (scenario === "membership") await db.prepare("UPDATE membership SET state = 'inactive'").run();
      if (scenario === "project") await db.prepare("UPDATE project SET state = 'archived'").run();
      if (scenario === "agent") await db.prepare("UPDATE identity SET state = 'inactive' WHERE kind = 'agent'").run();
      return db.batch(statements);
    });
    expect(await store(fixtures.valid, address, from, race)).toEqual({ status: "ineligible" });
    expect(await rows()).toHaveLength(0);
    expect(await states()).toHaveLength(0);
  });

  it("transactionally rolls back reservation on a storage failure, permitting a verified retry", async () => {
    await world();
    await env.HUB_DB.exec("CREATE TRIGGER fail_inbound BEFORE INSERT ON inbound_mail BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END");
    await expect(store()).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
    expect(await states()).toHaveLength(0);
    await env.HUB_DB.exec("DROP TRIGGER fail_inbound");
    expect((await store()).status).toBe("stored");
  });

  it("rolls admission and replay state back if its atomic audit fails", async () => {
    await world();
    await env.HUB_DB.exec("CREATE TRIGGER fail_mail_audit BEFORE INSERT ON event BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    await expect(store()).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
    expect(await states()).toHaveLength(0);
    await env.HUB_DB.exec("DROP TRIGGER fail_mail_audit");
    expect((await store()).status).toBe("stored");
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM event").first("n")).toBe(1);
  });

  it("rolls evidence and reservation back if finalization fails", async () => {
    await world();
    await env.HUB_DB.exec("CREATE TRIGGER fail_replay_finalize BEFORE UPDATE ON meta WHEN NEW.key LIKE 'mail_replay:%' BEGIN SELECT RAISE(ABORT, 'finalize unavailable'); END");
    await expect(store()).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
    expect(await states()).toHaveLength(0);
    await env.HUB_DB.exec("DROP TRIGGER fail_replay_finalize");
    expect((await store()).status).toBe("stored");
  });

  it("reconciles a committed batch with a lost response without duplicate storage or effects", async () => {
    await world();
    const db = env.HUB_DB;
    const lost = wrappedBatch(async (statements) => { await db.batch(statements); throw new Error("response lost"); });
    await expect(store(fixtures.valid, to, from, lost)).rejects.toThrow("response lost");
    expect((await store()).status).toBe("duplicate");
    expect(await rows()).toHaveLength(1);
    expect(await states()).toHaveLength(1);
  });

  it.each(["pending", "corrupt", "missing_row", "quarantined", "released"])("never reclaims/re-admits %s state", async (scenario) => {
    const w = await world(); await store();
    const s = (await states())[0]!;
    if (scenario === "pending") {
      const value = { ...JSON.parse(s.value), status: "pending" };
      await env.HUB_DB.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(JSON.stringify(value), s.key).run();
    }
    if (scenario === "corrupt") await env.HUB_DB.prepare("UPDATE meta SET value = 'not-json' WHERE key = ?").bind(s.key).run();
    if (scenario === "missing_row") await env.HUB_DB.prepare("DELETE FROM inbound_mail").run();
    if (scenario === "quarantined") await env.HUB_DB.prepare("UPDATE inbound_mail SET verdict = 'quarantined'").run();
    if (scenario === "released") await env.HUB_DB.prepare("UPDATE inbound_mail SET released_by = ?").bind(w.human.identity.id).run();
    const before = await states();
    expect(await store()).toEqual({ status: "blocked" });
    expect(await states()).toEqual(before);
    expect(await states()).toHaveLength(1);
  });

  it.each(["admitted", "quarantined"])("blocks pre-rollout %s replay with no fake proof upgrade", async (verdict) => {
    const w = await world();
    await env.HUB_DB.prepare(`INSERT INTO inbound_mail
      (id, tenant_id, identity_id, from_email, to_address, subject, message_id, received_at, size, verdict, text, attachments, forwarded)
      VALUES (?, ?, ?, ?, ?, '', '<dkim-fixture@example.com>', ?, 1, ?, '', '[]', 0)`)
      .bind(ulid(), w.tenant.id, w.human.identity.id, from, to, now, verdict).run();
    expect(await store()).toEqual({ status: "blocked" });
    expect(await rows()).toHaveLength(1);
    expect(await states()).toHaveLength(0);
  });

  it("does not change explicit consent withdrawal, even with an older active row", async () => {
    await world();
    await grantConsent(env.HUB_DB, { email: from, kind: "inbound_email", source_message_id: null, evidence: null }, now - 1);
    await revokeConsent(env.HUB_DB, from, now);
    await env.HUB_DB.prepare(`INSERT INTO consent (id, email, kind, granted_at, revoked_at)
      VALUES (?, ?, 'inbound_email', ?, NULL)`).bind(ulid(now - 10), from, now - 10).run();
    const before = (await env.HUB_DB.prepare("SELECT * FROM consent").all()).results;
    expect((await store()).status).toBe("stored");
    expect((await env.HUB_DB.prepare("SELECT * FROM consent").all()).results).toEqual(before);
  });

  it("bounds raw bytes before DNS, and snapshots mutable input before awaits", async () => {
    await world();
    const resolver = vi.fn(lookup);
    expect(await storeIndependentMailCandidate(env, { ...input(), bytes: new Uint8Array(10 * 1024 * 1024 + 1) }, now, resolver)).toEqual({ status: "ineligible" });
    expect(resolver).not.toHaveBeenCalled();
    const mutable = input();
    const pending = storeIndependentMailCandidate(env, mutable, now, lookup);
    mutable.bytes.fill(0);
    expect((await pending).status).toBe("stored");
    expect((await rows())[0]!.text).toBe("Original body.");
  });

  it("deletes only a removed tenant's replay records with its ordinary transaction", async () => {
    const w = await world(); await store();
    const other = await seedTenant("keepreplay");
    const key = REPLAY_PREFIX + other.id + ":" + await sha256Hex("other scope");
    await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, '{}')").bind(key).run();
    await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(w.tenant.id).run();
    await deleteTenant(env.HUB_DB, w.tenant.slug, w.human.identity.id, now);
    expect(await states()).toEqual([{ key, value: "{}" }]);
    expect(await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first()).not.toBeNull();
  });
});
