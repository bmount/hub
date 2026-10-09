import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "../src/ids";
import type { Env } from "../src/env";
import { grantConsent } from "../src/db/consent";
import { createProject } from "../src/db/projects";
import { resolveMailAddress } from "../src/mail/projectMail";
import { RESPONSE_RECIPIENT_PREFIX } from "../src/mail/responseRecipients";
import { sendNewcomerWelcome, WELCOME_PREFIX } from "../src/mail/welcome";
import * as delivery from "../src/mail/send";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const now = Date.now();
const proof = { authentication: "pass", source: "aligned_dkim", domain: "example.com", messageId: "<guidance@example.com>" } as const;
const pref = (tenant: string, project: string | null = null) => `${RESPONSE_RECIPIENT_PREFIX}${tenant}:${project ?? "org"}`;
const config = (recipients: string[]) => JSON.stringify({ revision: 1, recipients, updated_at: now, change_id: ulid() });
async function put(key: string, value: string) {
  await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value).run();
}
async function world(kind: "org" | "project" | "agent" = "org") {
  const tenant = await seedTenant("guidance");
  const human = await seedHuman("sender@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const bot = await seedAgent(tenant, human.identity, "helper");
  const project = await createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, now);
  const to = kind === "org" ? "guidance@pimwell.test" : kind === "project" ? "guidance.site@pimwell.test" : bot.agent.identity.email;
  const target = (await resolveMailAddress(env.HUB_DB, env.HUB_DOMAIN, to))!;
  const source = { tenant_id: tenant.id, identity_id: human.identity.id, mail_id: ulid() };
  await env.HUB_DB.prepare(`INSERT INTO inbound_mail
    (id, tenant_id, identity_id, project_id, recipient_id, from_email, to_address, subject, message_id, received_at, size, verdict, text, attachments, forwarded)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'evidence', ?, ?, 100, 'admitted', 'body', '[]', 0)`)
    .bind(source.mail_id, tenant.id, human.identity.id, target.project_id, target.recipient_id ?? null,
      human.identity.email, to, proof.messageId, now).run();
  await grantConsent(env.HUB_DB, { email: human.identity.email, kind: "inbound_email", source_message_id: null, evidence: null }, now);
  const sent: delivery.SentMail[] = [];
  delivery.setTestTransport(async m => { sent.push(m); });
  return { tenant, human, project, bot, source, sent, to, key: pref(tenant.id, target.project_id) };
}
const state = async (w: Awaited<ReturnType<typeof world>>) => {
  const raw = await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?")
    .bind(`${WELCOME_PREFIX}${w.tenant.id}:${w.human.identity.id}`).first<string>("value");
  return raw === null ? null : JSON.parse(raw);
};
// Inject changes exactly between observation and reservation, not after an outgoing send.
function beforeReserve(change: () => Promise<void>): Env {
  let changed = false;
  const db = new Proxy(env.HUB_DB, { get(target, prop) {
    if (prop === "prepare") return (sql: string) => {
      const stmt = target.prepare(sql);
      if (!sql.startsWith("INSERT INTO meta")) return stmt;
      return new Proxy(stmt, { get(s, p) {
        if (p === "bind") return (...args: unknown[]) => {
          const bound = s.bind(...args);
          return new Proxy(bound, { get(b, bp) {
            if (bp === "run") return async () => { if (!changed) { changed = true; await change(); } return b.run(); };
            const v = Reflect.get(b, bp); return typeof v === "function" ? v.bind(b) : v;
          } });
        };
        const v = Reflect.get(s, p); return typeof v === "function" ? v.bind(s) : v;
      } });
    };
    const v = Reflect.get(target, prop); return typeof v === "function" ? v.bind(target) : v;
  } });
  return { ...env, HUB_DB: db };
}
afterEach(() => { delivery.setTestTransport(null); vi.restoreAllMocks(); });

describe("one-time welcome conditional setup guidance", () => {
  it.each(["org", "project"] as const)("guides %s only for unset or explicitly empty preferences", async kind => {
    const w = await world(kind);
    await put(w.key, config([]));
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("sent");
    expect(w.sent[0]!.text).toContain("no configured response recipients");
    expect(w.sent[0]!.text).toContain("A human organization administrator");
    expect(w.sent[0]!.text).toContain(`/mail/recipients?address=${encodeURIComponent(w.to)}`);
    expect(w.sent[0]!.text).toContain("do not grant access, notify anyone, schedule a response or guarantee a reply");
    expect(await state(w)).toMatchObject({ setup_guidance: "no_configured_recipients", status: "sent" });
  });
  it.each(["configured", "stale", "foreign", "corrupt", "null", "duplicate", "malformed_empty"])("omits setup for %s without claiming a response or leaking recipient ids", async mode => {
    const w = await world();
    const other = await seedTenant("elsewhere");
    const outsider = await seedHuman("private@example.net", { memberships: [{ tenant_id: other.id, role: "member" }] });
    let raw = config([w.human.identity.id]);
    if (mode === "stale") {
      raw = config([outsider.identity.id]);
      await env.HUB_DB.prepare("UPDATE membership SET state = 'inactive' WHERE identity_id = ?").bind(outsider.identity.id).run();
    }
    if (mode === "foreign") raw = config([outsider.identity.id]);
    if (mode === "corrupt") raw = "{bad";
    if (mode === "null") raw = "null";
    if (mode === "duplicate") raw = config([outsider.identity.id, outsider.identity.id]);
    if (mode === "malformed_empty") raw = '{"recipients":[]}';
    await put(w.key, raw);
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("sent");
    const text = w.sent[0]!.text;
    expect(text).not.toContain("/mail/recipients");
    expect(text).not.toContain("/setup");
    expect(text).not.toContain("no configured response recipients");
    expect(text).not.toContain(outsider.identity.email);
    expect(text).not.toContain(outsider.identity.id);
    expect(text).toContain("Delivery does not guarantee a human or agent reply");
    expect(await state(w)).toMatchObject({ setup_guidance: "not_applicable", status: "sent" });
    expect(await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(w.key).first("value")).toBe(raw);
  });
  it("never inherits organization preferences into project guidance", async () => {
    const w = await world("project");
    await put(pref(w.tenant.id), config([w.human.identity.id]));
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("sent");
    expect(w.sent[0]!.text).toContain("no configured response recipients");
  });
  it("never inherits project preferences into organization guidance", async () => {
    const w = await world();
    await put(pref(w.tenant.id, w.project.id), config([w.human.identity.id]));
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("sent");
    expect(w.sent[0]!.text).toContain("no configured response recipients");
  });
  it("agent owner bypasses shared preferences even when corrupt; no setup guidance", async () => {
    const w = await world("agent"); await put(w.key, "{bad");
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("sent");
    expect(w.sent[0]!.text).toContain("an agent mailbox");
    expect(w.sent[0]!.text).not.toContain("/mail/recipients");
    expect(await state(w)).toMatchObject({ setup_guidance: "not_applicable" });
  });
  it.each(["absent_to_configured", "empty_to_configured", "configured_to_absent", "changed_revision"])("refuses a changed preference snapshot: %s", async mode => {
    const w = await world();
    if (mode === "empty_to_configured") await put(w.key, config([]));
    if (mode === "configured_to_absent" || mode === "changed_revision") await put(w.key, config([w.human.identity.id]));
    const e = beforeReserve(async () => {
      if (mode === "configured_to_absent") await env.HUB_DB.prepare("DELETE FROM meta WHERE key = ?").bind(w.key).run();
      else await put(w.key, config([w.human.identity.id]));
    });
    expect(await sendNewcomerWelcome(e, w.source, proof, now)).toBe("ineligible");
    expect(w.sent).toHaveLength(0); expect(await state(w)).toBeNull();
  });
  it.each(["destination", "tenant_rename", "project_archive", "agent_removal"])("refuses source/target changes before reservation: %s", async mode => {
    const w = await world(mode === "project_archive" ? "project" : mode === "agent_removal" ? "agent" : "org");
    const e = beforeReserve(async () => {
      if (mode === "destination") await env.HUB_DB.prepare("UPDATE inbound_mail SET to_address = 'guidance.site@pimwell.test' WHERE id = ?").bind(w.source.mail_id).run();
      if (mode === "tenant_rename") await env.HUB_DB.prepare("UPDATE tenant SET slug = 'renamedguidance' WHERE id = ?").bind(w.tenant.id).run();
      if (mode === "project_archive") await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.project.id).run();
      if (mode === "agent_removal") await env.HUB_DB.prepare("UPDATE membership SET state = 'inactive' WHERE identity_id = ?").bind(w.bot.agent.identity.id).run();
    });
    expect(await sendNewcomerWelcome(e, w.source, proof, now)).toBe("ineligible");
    expect(w.sent).toHaveLength(0); expect(await state(w)).toBeNull();
  });
  it("does not label a mismatched stored project/agent owner as the current target", async () => {
    const w = await world();
    await env.HUB_DB.prepare("UPDATE inbound_mail SET project_id = ? WHERE id = ?").bind(w.project.id, w.source.mail_id).run();
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("ineligible");
    await env.HUB_DB.prepare("UPDATE inbound_mail SET project_id = NULL, recipient_id = ? WHERE id = ?")
      .bind(w.bot.agent.identity.id, w.source.mail_id).run();
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("ineligible");
    expect(w.sent).toHaveLength(0); expect(await state(w)).toBeNull();
  });
  it("labels guidance as reservation-time evidence, not current or future configuration", async () => {
    const w = await world();
    delivery.setTestTransport(async m => { await put(w.key, config([w.human.identity.id])); w.sent.push(m); });
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("sent");
    expect(w.sent[0]!.text).toContain("At the welcome reservation");
    expect(await state(w)).toMatchObject({ setup_guidance: "no_configured_recipients" });
    expect(await sendNewcomerWelcome(env, w.source, proof, now + 1)).toBe("already_reserved");
    expect(w.sent).toHaveLength(1);
  });
  it("legacy welcome reservations remain terminal and never acquire a new guidance send", async () => {
    const w = await world();
    await put(`${WELCOME_PREFIX}${w.tenant.id}:${w.human.identity.id}`, JSON.stringify({
      attempt_id: ulid(), mail_id: w.source.mail_id, reserved_at: now, completed_at: null, status: "pending" }));
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("already_reserved");
    expect(w.sent).toHaveLength(0);
    expect(await state(w)).not.toHaveProperty("setup_guidance");
  });
  it("preference changes never resend an already reserved welcome", async () => {
    const w = await world(); await put(w.key, config([w.human.identity.id]));
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("sent");
    await put(w.key, config([]));
    expect(await sendNewcomerWelcome(env, w.source, proof, now + 1)).toBe("already_reserved");
    expect(w.sent).toHaveLength(1); expect(w.sent[0]!.text).not.toContain("/mail/recipients");
    expect(await state(w)).toMatchObject({ setup_guidance: "not_applicable" });
  });
});
