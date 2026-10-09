import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "../src/ids";
import { grantConsent, revokeConsent } from "../src/db/consent";
import { deleteTenant } from "../src/db/tenantDelete";
import { createProject } from "../src/db/projects";
import { sendNewcomerWelcome, WELCOME_PREFIX, type WelcomeSource, type WelcomeState } from "../src/mail/welcome";
import { resolveMailAddress } from "../src/mail/projectMail";
import type { DkimProof } from "../src/mail/dkim";
import * as delivery from "../src/mail/send";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const now = Date.now();
const proof: DkimProof = { authentication: "pass", source: "aligned_dkim", domain: "example.com", messageId: "<welcome@example.com>" };
const stateKey = (s: WelcomeSource) => `${WELCOME_PREFIX}${s.tenant_id}:${s.identity_id}`;
async function state(s: WelcomeSource): Promise<WelcomeState | null> {
  const value = await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(stateKey(s)).first<string>("value");
  return value ? JSON.parse(value) : null;
}
async function store(s: WelcomeSource, email: string, to: string) {
  const target = await resolveMailAddress(env.HUB_DB, env.HUB_DOMAIN, to);
  await env.HUB_DB.prepare(`INSERT INTO inbound_mail
    (id, tenant_id, identity_id, from_email, to_address, project_id, recipient_id, subject, message_id, received_at, size, verdict, text, attachments, forwarded)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'evidence', ?, ?, 100, 'admitted', 'body', '[]', 0)`)
    .bind(s.mail_id, s.tenant_id, s.identity_id, email, to, target?.project_id ?? null, target?.recipient_id ?? null,
      proof.authentication === "pass" ? proof.messageId : "", now).run();
}
async function world(opts: { root?: boolean } = {}) {
  const tenant = await seedTenant("welcometest");
  const human = await seedHuman("person@example.com", { is_root: opts.root, memberships: opts.root ? [] : [{ tenant_id: tenant.id, role: "member" }] });
  const source = { tenant_id: tenant.id, identity_id: human.identity.id, mail_id: ulid() };
  await store(source, human.identity.email, "welcometest@pimwell.test");
  await grantConsent(env.HUB_DB, { email: human.identity.email, kind: "inbound_email", source_message_id: null, evidence: null }, now);
  const sent: delivery.SentMail[] = [];
  delivery.setTestTransport(async (m) => { sent.push(m); });
  return { tenant, human, source, sent };
}
afterEach(() => { delivery.setTestTransport(null); vi.restoreAllMocks(); });

describe("independent-proof newcomer welcome candidate", () => {
  it("sends truthful setup context once, without modifying admission or consent", async () => {
    const w = await world();
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("sent");
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ from: "welcometest@pimwell.test", to: "person@example.com", subject: "Welcome to Pimwell" });
    expect(w.sent[0]!.text).toContain("https://welcometest.pimwell.test/mail/recipients?address=welcometest%40pimwell.test");
    expect(w.sent[0]!.text).toContain("Delivery does not guarantee");
    expect(w.sent[0]!.text).not.toContain("Received:");
    expect(await state(w.source)).toMatchObject({ status: "sent", mail_id: w.source.mail_id, reserved_at: now, completed_at: expect.any(Number) });
    expect((await state(w.source))!.completed_at).toBeGreaterThanOrEqual(now);
    expect(await sendNewcomerWelcome(env, w.source, proof, now + 1)).toBe("already_reserved");
    expect(w.sent).toHaveLength(1);
    expect(await env.HUB_DB.prepare("SELECT verdict, reason FROM inbound_mail WHERE id = ?").bind(w.source.mail_id).first())
      .toEqual({ verdict: "admitted", reason: null });
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) FROM consent").first("COUNT(*)")).toBe(1);
  });

  it("atomically deduplicates concurrent different messages across project and agent mailboxes", async () => {
    const w = await world();
    await createProject(env.HUB_DB, { tenant_id: w.tenant.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, now);
    const bot = await seedAgent(w.tenant, w.human.identity, "helper");
    const sources = [w.source];
    for (let i = 0; i < 10; i++) {
      const s = { ...w.source, mail_id: ulid() };
      await store(s, "person@example.com", i % 2 ? bot.agent.identity.email : "welcometest.site@pimwell.test");
      sources.push(s);
    }
    const results = await Promise.all(sources.map((s) => sendNewcomerWelcome(env, s, proof, now)));
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
    expect(results.filter((r) => r === "already_reserved")).toHaveLength(10);
    expect(w.sent).toHaveLength(1);
  });

  it("keeps organizations and identities independently scoped", async () => {
    const w = await world();
    const otherTenant = await seedTenant("otherwelcome");
    const otherHuman = await seedHuman("other@example.com", { memberships: [{ tenant_id: w.tenant.id, role: "member" }] });
    // Root can write either org; do not change actual users, only fixture state.
    await env.HUB_DB.prepare("UPDATE identity SET is_root = 1 WHERE id = ?").bind(w.human.identity.id).run();
    const s2 = { ...w.source, tenant_id: otherTenant.id, mail_id: ulid() };
    const s3 = { ...w.source, identity_id: otherHuman.identity.id, mail_id: ulid() };
    await store(s2, "person@example.com", "otherwelcome@pimwell.test");
    await store(s3, "other@example.com", "welcometest@pimwell.test");
    await grantConsent(env.HUB_DB, { email: "other@example.com", kind: "inbound_email", source_message_id: null, evidence: null }, now);
    expect(await Promise.all([w.source, s2, s3].map((s) => sendNewcomerWelcome(env, s, proof, now))))
      .toEqual(["sent", "sent", "sent"]);
    expect(w.sent).toHaveLength(3);
  });

  it.each(["quarantined", "released", "unknown_reason", "wrong_message", "wrong_sender", "inactive_human", "no_membership", "archived_tenant", "missing_target"])
    ("does not reserve or send for %s", async (scenario) => {
      const w = await world();
      const changes: Record<string, string> = {
        quarantined: "UPDATE inbound_mail SET verdict = 'quarantined'",
        released: "UPDATE inbound_mail SET released_by = identity_id",
        unknown_reason: "UPDATE inbound_mail SET reason = 'authentication unknown'",
        wrong_message: "UPDATE inbound_mail SET message_id = '<other@example.com>'",
        wrong_sender: "UPDATE inbound_mail SET from_email = 'other@example.com'",
        inactive_human: "UPDATE identity SET state = 'inactive'",
        no_membership: "UPDATE membership SET state = 'inactive'",
        archived_tenant: "UPDATE tenant SET state = 'archived'",
        missing_target: "UPDATE inbound_mail SET to_address = 'welcometest.missing@pimwell.test'",
      };
      await env.HUB_DB.prepare(changes[scenario]!).run();
      expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("ineligible");
      expect(w.sent).toHaveLength(0);
      expect(await state(w.source)).toBeNull();
    });

  it("rejects agents, wrong tenant/identity/source, unknown proof and misaligned signer", async () => {
    const w = await world();
    const other = await seedTenant("elsewhere");
    const bot = await seedAgent(w.tenant, w.human.identity, "bot");
    const agentSource = { ...w.source, identity_id: bot.agent.identity.id, mail_id: ulid() };
    await store(agentSource, bot.agent.identity.email, "welcometest@pimwell.test");
    for (const s of [agentSource, { ...w.source, tenant_id: other.id }, { ...w.source, identity_id: bot.agent.identity.id }, { ...w.source, mail_id: ulid() }, { ...w.source, tenant_id: "bad:key" }]) {
      expect(await sendNewcomerWelcome(env, s, proof, now)).toBe("ineligible");
    }
    expect(await sendNewcomerWelcome(env, w.source, { authentication: "unknown", source: null, reason: "unknown" }, now)).toBe("ineligible");
    expect(await sendNewcomerWelcome(env, w.source, { authentication: "pass", source: "aligned_dkim", domain: "outsider.com", messageId: "<welcome@example.com>" }, now)).toBe("ineligible");
    expect(w.sent).toHaveLength(0);
    expect(await state(w.source)).toBeNull();
  });

  it("requires consent without creating or reinstating it", async () => {
    const w = await world();
    await env.HUB_DB.prepare("DELETE FROM consent").run();
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("ineligible");
    await grantConsent(env.HUB_DB, { email: "person@example.com", kind: "inbound_email", source_message_id: null, evidence: null }, now);
    await revokeConsent(env.HUB_DB, "person@example.com", now + 1);
    expect(await sendNewcomerWelcome(env, w.source, proof, now + 2)).toBe("ineligible");
    expect(w.sent).toHaveLength(0);
    expect(await state(w.source)).toBeNull();
  });

  it("honors a latest withdrawal even if an older consent row remains active", async () => {
    const w = await world();
    await env.HUB_DB.prepare(`INSERT INTO consent (id, email, kind, granted_at, revoked_at)
      VALUES (?, 'person@example.com', 'inbound_email', ?, ?)`)
      .bind(ulid(now + 1), now + 1, now + 2).run();
    expect(await sendNewcomerWelcome(env, w.source, proof, now + 3)).toBe("ineligible");
    expect(await delivery.sendMail(env, { to: "person@example.com", subject: "optional", text: "context" }, now + 3)).toBe("no_consent");
    expect(w.sent).toHaveLength(0);
    expect(await state(w.source)).toBeNull();
  });

  it("records failures without retry, error detail, or changing the proven mail verdict", async () => {
    const w = await world();
    const secret = "credential-value-must-never-appear";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = new Error(secret); error.name = secret;
    delivery.setTestTransport(async () => { throw error; });
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("failed");
    expect(await state(w.source)).toMatchObject({ status: "failed", completed_at: expect.any(Number) });
    expect(JSON.stringify(await state(w.source))).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(await sendNewcomerWelcome(env, w.source, proof, now + 1)).toBe("already_reserved");
    expect(await env.HUB_DB.prepare("SELECT verdict FROM inbound_mail WHERE id = ?").bind(w.source.mail_id).first("verdict")).toBe("admitted");
  });

  it("retains pending after an ambiguous interruption and never blindly replays", async () => {
    const w = await world();
    vi.spyOn(delivery, "sendMail").mockRejectedValue(new Error("interrupted"));
    await expect(sendNewcomerWelcome(env, w.source, proof, now)).rejects.toThrow("interrupted");
    expect(await state(w.source)).toMatchObject({ status: "pending", completed_at: null });
    expect(await sendNewcomerWelcome(env, w.source, proof, now + 1)).toBe("already_reserved");
    expect(delivery.sendMail).toHaveBeenCalledTimes(1);
  });

  it("records consent denial after reservation separately, without automatic retry", async () => {
    const w = await world();
    vi.spyOn(delivery, "sendMail").mockResolvedValue("no_consent");
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("no_consent");
    expect(await state(w.source)).toMatchObject({ status: "no_consent" });
    expect(await sendNewcomerWelcome(env, w.source, proof, now + 1)).toBe("already_reserved");
    expect(w.sent).toHaveLength(0);
  });

  it("allows a verified root human without org membership", async () => {
    const w = await world({ root: true });
    expect(await sendNewcomerWelcome(env, w.source, proof, now)).toBe("sent");
  });

  it("deletes only this tenant's welcome state with its other data", async () => {
    const w = await world();
    const other = await seedTenant("keepwelcome");
    const otherKey = `${WELCOME_PREFIX}${other.id}:${w.human.identity.id}`;
    await env.HUB_DB.prepare("INSERT INTO meta (key, value) VALUES (?, '{}')").bind(otherKey).run();
    await sendNewcomerWelcome(env, w.source, proof, now);
    await env.HUB_DB.prepare("UPDATE tenant SET state = 'archived' WHERE id = ?").bind(w.tenant.id).run();
    await deleteTenant(env.HUB_DB, w.tenant.slug, w.human.identity.id, now);
    expect(await state(w.source)).toBeNull();
    expect(await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(otherKey).first("value")).toBe("{}");
    expect(await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first()).not.toBeNull();
  });
});
