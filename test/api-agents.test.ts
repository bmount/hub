import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { defineVerb, registerVerbs } from "../src/verbs/table";
import { optInt, reqString } from "../src/verbs/params";
import { esc } from "../src/html";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

beforeAll(() => {
  registerVerbs([
    defineVerb({ name: "test.member", kind: "query", scope: "tenant", minRole: "member", freshProofMinutes: null, summary: "m", parse: () => ({}), run: async (ctx) => ({ who: ctx.identity!.email }) }),
    defineVerb({ name: "test.humans", kind: "command", scope: "public", minRole: "public", freshProofMinutes: null, humanOnly: true, summary: "h", parse: () => ({}), run: async () => ({ done: true }) }),
    defineVerb({ name: "test.fresh", kind: "command", scope: "public", minRole: "public", freshProofMinutes: 60, summary: "f", parse: () => ({}), run: async () => ({ done: true }) }),
    defineVerb({
      name: "test.render", kind: "command", scope: "public", minRole: "public", freshProofMinutes: null, summary: "r",
      parse: (i) => ({ v: reqString(i, "v", { max: 40 }) }), run: async (_c, p) => ({ v: p.v }), renderForm: (r) => `<p id="out">${esc(r.v)}</p>`,
    }),
    defineVerb({ name: "test.int", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null, summary: "i", parse: (i) => ({ n: optInt(i, "n", { min: 1, max: 10 }) }), run: async (_c, p) => p }),
  ]);
});

const stale = (id: string) => env.HUB_DB.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(Date.now() - 61 * 60_000, id).run();
const form = (host: string, verb: string, fields: Record<string, string>, token: string) =>
  SELF.fetch(`https://${host}/api/${verb}`, {
    method: "POST", redirect: "manual",
    headers: { ...cookieHeaders(token, host), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

async function setup() {
  const acme = await seedTenant("acme");
  const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const s = await seedAgent(acme, op.identity);
  return { acme, op, s };
}

describe("long-lived tokens in the dispatcher", () => {
  it("may call whoami and nothing else", async () => {
    const { op, s } = await setup();
    const who = (await (await apiPost("acme.pimwell.test", "whoami", {}, bearer(s.longLived))).json()) as any;
    expect(who.result.identity).toMatchObject({ id: s.agent.identity.id, kind: "agent", email: "bot@acme.pimwell.test", operator_id: op.identity.id, is_root: false });
    expect(who.result.session).toBeNull();
    expect(who.result.token).toEqual({ id: s.apiToken.id, name: "ci" });
    expect(who.result.tenant.role).toBe("member");
    const denied = await apiPost("acme.pimwell.test", "test.member", {}, bearer(s.longLived));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as any).detail).toContain("session.start");
    expect((await apiPost("acme.pimwell.test", "project.list", {}, bearer(s.longLived))).status).toBe(403);
  });

  it("lets a run session call member verbs but not human-only ones", async () => {
    const { s } = await setup();
    expect((await apiPost("acme.pimwell.test", "test.member", {}, bearer(s.token))).status).toBe(200);
    expect((await apiPost("acme.pimwell.test", "test.humans", {}, bearer(s.token))).status).toBe(403);
    const who = (await (await apiPost("acme.pimwell.test", "whoami", {}, bearer(s.token))).json()) as any;
    expect(who.result.session).toMatchObject({ id: s.session.id, kind: "agent_run", label: "run-1" });
    expect(who.result.token).toBeNull();
  });
});

describe("fresh proof and forms", () => {
  it("applies fresh proof to a public verb for browser sessions only", async () => {
    const { op, s } = await setup();
    expect((await apiPost("pimwell.test", "test.fresh", {}, bearer(op.token))).status).toBe(200);
    await stale(op.session.id);
    const res = await apiPost("pimwell.test", "test.fresh", {}, bearer(op.token));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("reproof_required");
    await stale(s.session.id);
    expect((await apiPost("acme.pimwell.test", "test.fresh", {}, bearer(s.token))).status).toBe(200);
    expect((await apiPost("pimwell.test", "test.fresh", {})).status).toBe(200);
  });

  it("renders a page for verbs with renderForm, JSON otherwise", async () => {
    const h = await seedHuman("a@example.com");
    const res = await form("pimwell.test", "test.render", { v: "<x>" }, h.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain('<p id="out">&lt;x&gt;</p>');
    const json = (await (await apiPost("pimwell.test", "test.render", { v: "y" })).json()) as any;
    expect(json.result).toEqual({ v: "y" });
  });

  it("redirects form posts to a same-origin _back path only", async () => {
    const h = await seedHuman("a@example.com");
    const ok = await form("pimwell.test", "test.humans", { _back: "/me" }, h.token);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/me");
    for (const bad of ["//evil.example/x", "https://evil.example/", "/a\\b", "/x\r\nset-cookie: a=b"]) {
      const res = await form("pimwell.test", "test.humans", { _back: bad }, h.token);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  it("parses integers strictly", async () => {
    expect(((await (await apiPost("pimwell.test", "test.int", { n: 3 })).json()) as any).result).toEqual({ n: 3 });
    expect(((await (await apiPost("pimwell.test", "test.int", { n: "7" })).json()) as any).result).toEqual({ n: 7 });
    expect(((await (await apiPost("pimwell.test", "test.int", {})).json()) as any).result).toEqual({ n: null });
    for (const n of [0, 11, 2.5, "3x", "", true]) {
      const res = await apiPost("pimwell.test", "test.int", { n });
      if (n === "") expect(res.status).toBe(200);
      else expect(res.status).toBe(400);
    }
  });
});
