import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getSessionByToken } from "../src/db/sessions";
import { getApiTokenByToken } from "../src/db/apiTokens";
import { acceptInvite, createInvite } from "../src/db/invites";
import { apiPost, bearer, seedAgent, seedHuman, seedTenant } from "./helpers";

const ev = (kind: string) => env.HUB_DB.prepare("SELECT tenant_id, identity_id, session_id, target_id, summary FROM event WHERE kind = ?").bind(kind).first<Record<string, string>>();
const stale = (id: string) => env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, id).run();

async function setup() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const admin = await seedHuman("admin@example.com", { memberships: [{ tenant_id: acme.id, role: "admin" }] });
  const member = await seedHuman("m@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const reader = await seedHuman("r@example.com", { memberships: [{ tenant_id: acme.id, role: "reader" }] });
  return { acme, blue, admin, member, reader };
}

describe("agent.create", () => {
  it("lets a member create their own agent on the tenant host or from the apex", async () => {
    const { acme, member } = await setup();
    const res = await apiPost("acme.pimwell.test", "agent.create", { slug: "Bot", display_name: "Build bot" }, bearer(member.token));
    expect(res.status).toBe(200);
    const a = ((await res.json()) as any).result.agent;
    expect(a).toMatchObject({ slug: "bot", address: "acme.bot@pimwell.test", display_name: "Build bot", tenant: "acme", role: "member", operator_id: member.identity.id, state: "active" });
    expect(await ev("agent.create")).toMatchObject({ tenant_id: acme.id, identity_id: member.identity.id, session_id: member.session.id, target_id: a.id });
    const apex = await apiPost("pimwell.test", "agent.create", { tenant: "acme", slug: "two", display_name: "Two", role: "reader" }, bearer(member.token));
    expect(((await apex.json()) as any).result.agent).toMatchObject({ address: "acme.two@pimwell.test", role: "reader" });
    expect((await apiPost("pimwell.test", "agent.create", { slug: "three", display_name: "Three" }, bearer(member.token))).status).toBe(400);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "bot", display_name: "Again" }, bearer(member.token))).status).toBe(409);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "x", display_name: "X", role: "admin" }, bearer(member.token))).status).toBe(400);
  });

  it("refuses readers, non-members, anonymous callers, agents, and stale proof", async () => {
    const { acme, member, reader } = await setup();
    const outsider = await seedHuman("out@example.com");
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "a", display_name: "A" }, bearer(reader.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "a", display_name: "A" }, bearer(outsider.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "agent.create", { tenant: "blue", slug: "a", display_name: "A" }, bearer(member.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "agent.create", { tenant: "nope", slug: "a", display_name: "A" }, bearer(member.token))).status).toBe(404);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "a", display_name: "A" })).status).toBe(401);
    const s = await seedAgent(acme, member.identity);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "child", display_name: "C" }, bearer(s.token))).status).toBe(403);
    await stale(member.session.id);
    const res = await apiPost("acme.pimwell.test", "agent.create", { slug: "a", display_name: "A" }, bearer(member.token));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("reproof_required");
  });

  it("lets only an admin name another operator, who must be a human member", async () => {
    const { admin, member, reader } = await setup();
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "a", display_name: "A", operator: "admin@example.com" }, bearer(member.token))).status).toBe(403);
    const ok = await apiPost("acme.pimwell.test", "agent.create", { slug: "a", display_name: "A", operator: "M@Example.com" }, bearer(admin.token));
    expect(((await ok.json()) as any).result.agent.operator_id).toBe(member.identity.id);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "b", display_name: "B", operator: "r@example.com" }, bearer(admin.token))).status).toBe(400);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "c", display_name: "C", operator: "nobody@example.com" }, bearer(admin.token))).status).toBe(400);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "d", display_name: "D", operator: "acme.a@pimwell.test" }, bearer(admin.token))).status).toBe(400);
    expect((await apiPost("acme.pimwell.test", "agent.create", { slug: "e", display_name: "E", operator: reader.identity.email }, bearer(admin.token))).status).toBe(400);
  });

  it("lets a root create an agent in any tenant", async () => {
    await setup();
    const root = await seedHuman("root@example.com", { is_root: true });
    expect((await apiPost("pimwell.test", "agent.create", { tenant: "blue", slug: "r", display_name: "R" }, bearer(root.token))).status).toBe(200);
  });
});

describe("agent.archive", () => {
  it("lets the operator archive, revoking tokens and sessions, once", async () => {
    const { acme, member } = await setup();
    const s = await seedAgent(acme, member.identity);
    const res = await apiPost("pimwell.test", "agent.archive", { agent_id: s.agent.identity.id }, bearer(member.token));
    expect(((await res.json()) as any).result).toEqual({ ok: true, tokens_revoked: 1, sessions_revoked: 1 });
    expect(await getSessionByToken(env.HUB_DB, s.token, Date.now())).toBeNull();
    expect(await getApiTokenByToken(env.HUB_DB, s.longLived, Date.now())).toBeNull();
    expect(await ev("agent.archive")).toMatchObject({ tenant_id: acme.id, session_id: member.session.id, target_id: s.agent.identity.id });
    expect((await apiPost("pimwell.test", "agent.archive", { agent_id: s.agent.identity.id }, bearer(member.token))).status).toBe(409);
    const who = (await (await apiPost("acme.pimwell.test", "whoami", {}, bearer(s.token))).json()) as any;
    expect(who.result.identity).toBeNull();
  });

  it("lets an admin archive any agent in the tenant and hides agents from everyone else", async () => {
    const { acme, admin, member, reader } = await setup();
    const other = await seedHuman("o@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const s = await seedAgent(acme, member.identity);
    expect((await apiPost("pimwell.test", "agent.archive", { agent_id: s.agent.identity.id }, bearer(other.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "agent.archive", { agent_id: s.agent.identity.id }, bearer(reader.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "agent.archive", { agent_id: member.identity.id }, bearer(admin.token))).status).toBe(404);
    expect((await apiPost("pimwell.test", "agent.archive", { agent_id: "NOPE" }, bearer(admin.token))).status).toBe(404);
    expect((await apiPost("acme.pimwell.test", "agent.archive", { agent_id: s.agent.identity.id }, bearer(s.token))).status).toBe(403);
    expect((await apiPost("acme.pimwell.test", "agent.archive", { agent_id: s.agent.identity.id }, bearer(admin.token))).status).toBe(200);
  });
});

describe("agent addresses are not invitable", () => {
  it("rejects invites to tenant-domain addresses and never accepts for an agent identity", async () => {
    const { acme, blue, admin, member } = await setup();
    const res = await apiPost("acme.pimwell.test", "invite.create", { email: "acme.x@pimwell.test", role: "member" }, bearer(admin.token));
    expect(res.status).toBe(400);
    const s = await seedAgent(acme, member.identity);
    const { invite } = await createInvite(env.HUB_DB, { tenant_id: blue.id, email: s.agent.identity.email, role: "member", display_name: null, created_by: null }, Date.now());
    expect(await acceptInvite(env.HUB_DB, invite, Date.now())).toBeNull();
  });
});
