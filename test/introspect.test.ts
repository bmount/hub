import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { introspect } from "../src/http/internal";
import { createGitSession, revokeSession } from "../src/db/sessions";
import { revokeApiToken } from "../src/db/apiTokens";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const SECRET = "test-internal-secret";
const req = (body: unknown, headers: Record<string, string> = { "x-hub-internal": SECRET }) =>
  new Request("https://hub.internal/internal/introspect", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const gitFor = async (identityId: string, tenantId: string) =>
  createGitSession(env.HUB_DB, { identity_id: identityId, tenant_id: tenantId, label: "laptop" }, Date.now());
const call = async (body: unknown, headers?: Record<string, string>) => {
  const res = await introspect(req(body, headers), env);
  return { status: res.status, text: await res.text() };
};

async function setup() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const human = await seedHuman("m@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "member" }] });
  const s = await seedAgent(acme, human.identity);
  return { acme, blue, human, s };
}

describe("internal introspection", () => {
  it("is a 404 without the right secret, without a configured secret, or from a public route", async () => {
    const { human } = await setup();
    const body = { token: human.token, tenant: "acme" };
    expect((await call(body, {})).status).toBe(404);
    expect((await call(body, { "x-hub-internal": "wrong" })).status).toBe(404);
    expect((await call(body, { "x-hub-internal": SECRET + "x" })).status).toBe(404);
    expect((await call(body, { "x-hub-internal": SECRET, "cf-connecting-ip": "198.51.100.7" })).status).toBe(404);
    const closed = await introspect(req(body), { ...env, HUB_INTERNAL_SECRET: undefined });
    expect(closed.status).toBe(404);
    const empty = await introspect(req(body, { "x-hub-internal": "" }), { ...env, HUB_INTERNAL_SECRET: "" });
    expect(empty.status).toBe(404);
  });

  it("describes a human git session that is a member of the tenant, without echoing the token", async () => {
    const { human, acme } = await setup();
    const g = await gitFor(human.identity.id, acme.id);
    const r = await call({ token: g.token, tenant: "acme" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({
      ok: true,
      identity: { id: human.identity.id, kind: "human", display_name: "m", email: "m@example.com", operator_id: null },
      session: { id: g.session.id, kind: "git", label: "laptop" },
      tenant: { slug: "acme" },
      role: "member",
    });
    expect(r.text).not.toContain(g.token);
  });

  it("gives roots their role on any tenant and refuses non-members", async () => {
    const { acme, blue } = await setup();
    const root = await seedHuman("root@example.com", { is_root: true });
    const out = await seedHuman("out@example.com");
    const rootGit = await gitFor(root.identity.id, blue.id);
    const outGit = await gitFor(out.identity.id, acme.id);
    expect(JSON.parse((await call({ token: rootGit.token, tenant: "blue" })).text).role).toBe("root");
    expect(JSON.parse((await call({ token: outGit.token, tenant: "acme" })).text)).toEqual({ ok: false });
  });

  it("describes an agent run on its own tenant and refuses it elsewhere", async () => {
    const { human, s } = await setup();
    const ok = JSON.parse((await call({ token: s.token, tenant: "acme" })).text);
    expect(ok).toMatchObject({
      ok: true, identity: { id: s.agent.identity.id, kind: "agent", email: "acme.bot@pimwell.test", operator_id: human.identity.id },
      session: { id: s.session.id, kind: "agent_run", label: "run-1" }, tenant: { slug: "acme" }, role: "member",
    });
    expect(JSON.parse((await call({ token: s.token, tenant: "blue" })).text)).toEqual({ ok: false });
    expect(JSON.parse((await call({ token: s.longLived, tenant: "acme" })).text)).toEqual({ ok: false });
  });

  it("refuses revoked sessions, revoked parent tokens, and malformed input", async () => {
    const { human, s } = await setup();
    await revokeApiToken(env.HUB_DB, s.apiToken.id, Date.now());
    expect(JSON.parse((await call({ token: s.token, tenant: "acme" })).text)).toEqual({ ok: false });
    await revokeSession(env.HUB_DB, human.session.id, Date.now());
    expect(JSON.parse((await call({ token: human.token, tenant: "acme" })).text)).toEqual({ ok: false });
    for (const body of ["not json", [], {}, { token: 5, tenant: "acme" }, { token: "pms_x", tenant: "-bad-" }, { token: "pms_x", tenant: "www" }]) {
      const r = await call(body);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text)).toEqual({ ok: false });
    }
  });

  it("is routed for POST only", async () => {
    const { human, acme } = await setup();
    const g = await gitFor(human.identity.id, acme.id);
    const post = await worker.fetch!(req({ token: g.token, tenant: "acme" }) as never, env, createExecutionContext());
    expect(post.status).toBe(200);
    expect(((await post.json()) as any).ok).toBe(true);
    const get = await worker.fetch!(new Request("https://hub.internal/internal/introspect", { headers: { "x-hub-internal": SECRET } }) as never, env, createExecutionContext());
    expect(get.status).toBe(404);
  });
});
