import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  archiveAgent, createAgent, getAgentById, getAgentBySlug, isAgentDomainAddress, listAgentsForOperator,
  listAgentsForTenant, normalizeAgentSlug, tenantAgentActivity,
} from "../src/db/agents";
import {
  createApiToken, getApiTokenById, getApiTokenByToken, listApiTokensForIdentity, listApiTokensForOperator,
  listApiTokensForTenant, markApiTokenUsed, revokeApiToken,
} from "../src/db/apiTokens";
import {
  createAgentSession, getSessionById, getSessionByToken, listAgentRunsForOperator, SESSION_TOUCH_INTERVAL_MS, touchSession,
} from "../src/db/sessions";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const db = () => env.HUB_DB;

describe("agent repository", () => {
  it("creates an agent identity with a reserved address and one membership", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const a = await createAgent(db(), { tenant: t, slug: " Bot ", display_name: "Build bot", operator_id: op.identity.id, role: "member", hubDomain: "pimwell.test" }, Date.now());
    expect(a.slug).toBe("bot");
    expect(a.identity).toMatchObject({ kind: "agent", email: "bot@acme.pimwell.test", operator_id: op.identity.id, is_root: 0, state: "active" });
    expect(a.membership).toMatchObject({ tenant_id: t.id, role: "member", state: "active" });
    expect((await getAgentById(db(), a.identity.id))!.tenant.slug).toBe("acme");
    expect((await getAgentBySlug(db(), t, "bot", "pimwell.test"))!.identity.id).toBe(a.identity.id);
    expect((await listAgentsForTenant(db(), t.id, "active")).map((x) => x.slug)).toEqual(["bot"]);
    expect((await listAgentsForOperator(db(), op.identity.id)).map((x) => x.identity.email)).toEqual(["bot@acme.pimwell.test"]);
    expect(await getAgentById(db(), op.identity.id)).toBeNull();
  });

  it("rejects bad and reserved slugs and duplicates in a tenant, but allows the slug in another tenant", async () => {
    for (const bad of ["-x", "a_b", "admin", "postmaster", "no-reply", ""]) expect(() => normalizeAgentSlug(bad)).toThrow("invalid agent slug");
    const acme = await seedTenant("acme");
    const blue = await seedTenant("blue");
    const op = await seedHuman("op@example.com");
    const input = { slug: "bot", display_name: "Bot", operator_id: op.identity.id, role: "member" as const, hubDomain: "pimwell.test" };
    await createAgent(db(), { ...input, tenant: acme }, Date.now());
    await expect(createAgent(db(), { ...input, tenant: acme }, Date.now())).rejects.toMatchObject({ status: 409 });
    const other = await createAgent(db(), { ...input, tenant: blue }, Date.now());
    expect(other.identity.email).toBe("bot@blue.pimwell.test");
    await expect(createAgent(db(), { ...input, slug: "x", display_name: "  ", tenant: acme }, Date.now())).rejects.toMatchObject({ status: 400 });
  });

  it("recognises addresses under tenant subdomains of the hub", () => {
    expect(isAgentDomainAddress("bot@acme.pimwell.test", "pimwell.test")).toBe(true);
    expect(isAgentDomainAddress(" X@Acme.Pimwell.Test ", "pimwell.test")).toBe(true);
    expect(isAgentDomainAddress("login@pimwell.test", "pimwell.test")).toBe(false);
    expect(isAgentDomainAddress("a@example.com", "pimwell.test")).toBe(false);
    expect(isAgentDomainAddress("x@acme.pimwell.test.", "pimwell.test")).toBe(true);
    expect(isAgentDomainAddress("a@b@acme.pimwell.test", "pimwell.test")).toBe(true);
    expect(isAgentDomainAddress("a@notpimwell.test", "pimwell.test")).toBe(false);
  });
});

describe("api tokens", () => {
  it("stores only a SHA-256 hash and resolves live plaintext", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const s = await seedAgent(t, op.identity);
    expect(s.longLived).toMatch(/^pmw_[A-Za-z0-9_-]{43}$/);
    expect(s.apiToken.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const raw = await db().prepare("SELECT COUNT(*) AS n FROM api_token WHERE token_hash = ? OR name = ?").bind(s.longLived, s.longLived).first<{ n: number }>();
    expect(raw!.n).toBe(0);
    expect((await getApiTokenByToken(db(), s.longLived, Date.now()))!.id).toBe(s.apiToken.id);
    expect(await getApiTokenByToken(db(), s.token, Date.now())).toBeNull();
    expect(await getApiTokenByToken(db(), "pmw_nope", Date.now())).toBeNull();

    const now = Date.now();
    const short = await createApiToken(db(), { identity_id: s.agent.identity.id, tenant_id: t.id, name: "short", created_by: op.identity.id, expires_at: now + 1000 }, now);
    expect(await getApiTokenByToken(db(), short.plaintext, now + 500)).not.toBeNull();
    expect(await getApiTokenByToken(db(), short.plaintext, now + 2000)).toBeNull();

    await markApiTokenUsed(db(), s.apiToken.id, now + 7);
    expect((await getApiTokenById(db(), s.apiToken.id))!.last_used_at).toBe(now + 7);
  });

  it("revoking a token revokes the sessions it started, and only those", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const s = await seedAgent(t, op.identity);
    const second = await createApiToken(db(), { identity_id: s.agent.identity.id, tenant_id: t.id, name: "other", created_by: op.identity.id, expires_at: null }, Date.now());
    const otherRun = await createAgentSession(db(), { identity_id: s.agent.identity.id, tenant_id: t.id, label: "run-2", parent_token_id: second.token.id, ttl_s: 3600 }, Date.now());
    expect(await revokeApiToken(db(), s.apiToken.id, Date.now())).toEqual({ revoked: true, sessions: 1 });
    expect(await getSessionByToken(db(), s.token, Date.now())).toBeNull();
    expect(await getApiTokenByToken(db(), s.longLived, Date.now())).toBeNull();
    expect(await getSessionByToken(db(), otherRun.token, Date.now())).not.toBeNull();
    expect(await revokeApiToken(db(), s.apiToken.id, Date.now())).toEqual({ revoked: false, sessions: 0 });
  });

  it("lists live tokens by agent, tenant, and operator", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const other = await seedHuman("other@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const mine = await seedAgent(t, op.identity, "mine");
    const theirs = await seedAgent(t, other.identity, "theirs");
    expect((await listApiTokensForIdentity(db(), mine.agent.identity.id, Date.now())).map((x) => x.id)).toEqual([mine.apiToken.id]);
    expect((await listApiTokensForTenant(db(), t.id, Date.now())).length).toBe(2);
    const byOp = await listApiTokensForOperator(db(), op.identity.id, Date.now());
    expect(byOp.map((x) => [x.token.id, x.agent_email, x.tenant_slug])).toEqual([[mine.apiToken.id, "mine@acme.pimwell.test", "acme"]]);
    await revokeApiToken(db(), theirs.apiToken.id, Date.now());
    expect((await listApiTokensForTenant(db(), t.id, Date.now())).map((x) => x.id)).toEqual([mine.apiToken.id]);
  });
});

describe("agent run sessions", () => {
  it("creates a pinned agent_run session with the given ttl", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const s = await seedAgent(t, op.identity);
    const now = Date.now();
    const r = await createAgentSession(db(), { identity_id: s.agent.identity.id, tenant_id: t.id, label: "nightly", parent_token_id: s.apiToken.id, ttl_s: 3600 }, now);
    expect(r.token).toMatch(/^pms_/);
    expect(r.session).toMatchObject({ kind: "agent_run", tenant_id: t.id, label: "nightly", parent_token_id: s.apiToken.id, expires_at: now + 3600_000 });
    expect((await getSessionById(db(), r.session.id))!.token_hash).toBe(r.session.token_hash);
  });

  it("touching a run updates last_seen_at but never extends its expiry", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const s = await seedAgent(t, op.identity);
    const now = Date.now();
    const r = await createAgentSession(db(), { identity_id: s.agent.identity.id, tenant_id: t.id, label: "x", parent_token_id: s.apiToken.id, ttl_s: 3600 }, now);
    const later = now + SESSION_TOUCH_INTERVAL_MS + 1;
    const touched = await touchSession(db(), r.session, later);
    expect(touched.last_seen_at).toBe(later);
    expect(touched.expires_at).toBe(now + 3600_000);
    expect((await getSessionById(db(), r.session.id))!.expires_at).toBe(now + 3600_000);
  });

  it("archiving an agent revokes all its tokens and sessions", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const s = await seedAgent(t, op.identity);
    expect(await archiveAgent(db(), s.agent.identity.id, Date.now())).toEqual({ archived: true, tokens: 1, sessions: 1 });
    expect((await getAgentById(db(), s.agent.identity.id))!.identity.state).toBe("archived");
    expect(await getApiTokenByToken(db(), s.longLived, Date.now())).toBeNull();
    expect(await getSessionByToken(db(), s.token, Date.now())).toBeNull();
    expect(await listAgentsForTenant(db(), t.id, "active")).toEqual([]);
    expect((await listAgentsForTenant(db(), t.id, "archived")).length).toBe(1);
    expect(await archiveAgent(db(), s.agent.identity.id, Date.now())).toEqual({ archived: false, tokens: 0, sessions: 0 });
    expect(await archiveAgent(db(), op.identity.id, Date.now())).toEqual({ archived: false, tokens: 0, sessions: 0 });
  });

  it("counts live tokens and runs per agent and lists an operator's runs", async () => {
    const t = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    const s = await seedAgent(t, op.identity);
    const activity = await tenantAgentActivity(db(), t.id, Date.now());
    expect(activity.get(s.agent.identity.id)).toEqual({ tokens: 1, runs: 1 });
    const runs = await listAgentRunsForOperator(db(), op.identity.id, Date.now());
    expect(runs.map((r) => [r.session.id, r.session.label, r.agent_email, r.tenant_slug])).toEqual([[s.session.id, "run-1", "bot@acme.pimwell.test", "acme"]]);
    expect(JSON.stringify(runs)).not.toContain(s.token);
  });
});
