import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { defineVerb, registerVerbs } from "../src/verbs/table";
import { reqString } from "../src/verbs/params";
import { createTenant } from "../src/db/tenants";
import { createIdentity } from "../src/db/identities";
import { addMembership } from "../src/db/memberships";
import { createBrowserSession } from "../src/db/sessions";
import { seedHuman } from "./helpers";
import { COOKIE_NAME } from "../src/auth/cookie";

const db = () => env.HUB_DB;
const HOUR = 3600 * 1000;

beforeAll(() => {
  registerVerbs([
    defineVerb({
      name: "test.echo", kind: "query", scope: "tenant", minRole: "member", freshProofMinutes: null, summary: "echo",
      parse: (i) => ({ msg: reqString(i, "msg", { max: 20 }) }),
      run: async (ctx, p) => ({ msg: p.msg, tenant: ctx.tenant!.slug, who: ctx.identity!.email }),
    }),
    defineVerb({
      name: "test.admin", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, summary: "admin",
      parse: () => ({}),
      run: async () => ({ done: true }),
    }),
    defineVerb({
      name: "test.open", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null, summary: "open",
      parse: () => ({}),
      run: async () => ({ hi: true }),
    }),
  ]);
});

async function seed(role: "member" | "admin" = "member") {
  const tenant = await createTenant(db(), { slug: "acme", display_name: "Acme" }, Date.now());
  const identity = await createIdentity(db(), { kind: "human", email: "a@example.com", display_name: "A", is_root: 0, operator_id: null }, Date.now());
  await addMembership(db(), { identity_id: identity.id, tenant_id: tenant.id, role }, Date.now());
  const { session, token } = await createBrowserSession(db(), identity.id, Date.now());
  return { tenant, identity, session, token };
}

function post(host: string, verb: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`https://${host}/api/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("api dispatcher", () => {
  it("runs a public verb with no auth", async () => {
    const res = await post("pimwell.test", "test.open", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { hi: true } });
  });

  it("404s unknown verbs and unknown tenants alike", async () => {
    expect((await post("pimwell.test", "nope", {})).status).toBe(404);
    expect((await post("zzz.pimwell.test", "test.echo", { msg: "x" })).status).toBe(404);
  });

  it("requires auth, then role, with a bearer token", async () => {
    const s = await seed("member");
    expect((await post("acme.pimwell.test", "test.echo", { msg: "x" })).status).toBe(404);
    const ok = await post("acme.pimwell.test", "test.echo", { msg: "hi" }, { authorization: `Bearer ${s.token}` });
    expect(await ok.json()).toEqual({ ok: true, result: { msg: "hi", tenant: "acme", who: "a@example.com" } });
    const denied = await post("acme.pimwell.test", "test.admin", {}, { authorization: `Bearer ${s.token}` });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string; detail: string }).error).toBe("forbidden");
  });

  it("404s a signed-in non-member of the tenant", async () => {
    await seed("member");
    const outsider = await seedHuman("out@example.com");
    expect((await post("acme.pimwell.test", "test.echo", { msg: "x" }, { authorization: `Bearer ${outsider.token}` })).status).toBe(404);
  });

  it("rejects cookie auth without a matching Origin", async () => {
    const s = await seed("admin");
    const noOrigin = await post("acme.pimwell.test", "test.echo", { msg: "x" }, { cookie: `${COOKIE_NAME}=${s.token}` });
    expect(noOrigin.status).toBe(403);
    expect(((await noOrigin.json()) as { error: string; detail: string }).error).toBe("bad_origin");
    const wrong = await post("acme.pimwell.test", "test.echo", { msg: "x" }, { cookie: `${COOKIE_NAME}=${s.token}`, origin: "https://evil.example" });
    expect(wrong.status).toBe(403);
    const right = await post("acme.pimwell.test", "test.echo", { msg: "x" }, { cookie: `${COOKIE_NAME}=${s.token}`, origin: "https://acme.pimwell.test" });
    expect(right.status).toBe(200);
  });

  it("enforces fresh proof for cookie sessions", async () => {
    const s = await seed("admin");
    await db().prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60 * 1000, s.session.id).run();
    const stale = await post("acme.pimwell.test", "test.admin", {}, { cookie: `${COOKIE_NAME}=${s.token}`, origin: "https://acme.pimwell.test" });
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { error: string; detail: string }).error).toBe("reproof_required");
    await db().prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 59 * 60 * 1000, s.session.id).run();
    const fresh = await post("acme.pimwell.test", "test.admin", {}, { cookie: `${COOKIE_NAME}=${s.token}`, origin: "https://acme.pimwell.test" });
    expect(fresh.status).toBe(200);
  });

  it("enforces fresh proof for browser sessions sent as bearer", async () => {
    const s = await seed("admin");
    await db().prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60 * 1000, s.session.id).run();
    const stale = await post("acme.pimwell.test", "test.admin", {}, { authorization: `Bearer ${s.token}` });
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { error: string; detail: string }).error).toBe("reproof_required");
    await db().prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now(), s.session.id).run();
    const fresh = await post("acme.pimwell.test", "test.admin", {}, { authorization: `Bearer ${s.token}` });
    expect(fresh.status).toBe(200);
  });

  it("validates params", async () => {
    const s = await seed("member");
    const res = await post("acme.pimwell.test", "test.echo", { msg: "x".repeat(21) }, { authorization: `Bearer ${s.token}` });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string; detail: string }).detail).toContain("msg");
  });

  it("accepts form bodies and redirects", async () => {
    const s = await seed("member");
    const res = await SELF.fetch("https://acme.pimwell.test/api/test.echo", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${COOKIE_NAME}=${s.token}`, origin: "https://acme.pimwell.test", referer: "https://acme.pimwell.test/somewhere" },
      body: "msg=hi",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://acme.pimwell.test/somewhere");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("ignores a cross-origin referer on form posts", async () => {
    const s = await seed("member");
    const res = await SELF.fetch("https://acme.pimwell.test/api/test.echo", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${COOKIE_NAME}=${s.token}`, origin: "https://acme.pimwell.test", referer: "https://evil.example/x" },
      body: "msg=hi",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("clears a stale cookie", async () => {
    const res = await post("pimwell.test", "test.open", {}, { cookie: `${COOKIE_NAME}=pms_stale` });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
