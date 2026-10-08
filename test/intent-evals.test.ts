// The intent eval harness: judging, the guarded runner, and that every model call is attributed to a named agent and
// project. The real-model runs happen against production through POST /internal/evals/intent.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setModelFetchForTest } from "../src/models/providers";
import { addCredential } from "../src/models/store";
import { createProject } from "../src/db/projects";
import { createAgent } from "../src/db/agents";
import { CASES, judge } from "../src/intent/evals";
import { parseIntent } from "../src/intent/catalog";
import { cookieHeaders, seedHuman, seedTenant } from "./helpers";

afterEach(() => setModelFetchForTest(null));

/** A stand-in that gives the first expected answer for each case, so the harness itself can be checked. */
function answerFor(say: string): string {
  const c = CASES.find((x) => say.endsWith(`Person: ${x.say}`));
  if (!c) return '{"none":"?"}';
  if (c.expect === "none") return '{"none":"Not something I can do here."}';
  if (c.expect === "ask") return '{"ask":"Which one?"}';
  return JSON.stringify({ action: c.expect[0]!.action, params: c.expect[0]!.params ?? {} });
}

describe("intent evals", () => {
  it("judges outcomes by action and params, and a wrong action fails", () => {
    const c = CASES.find((x) => x.id === "add-agent")!;
    expect(judge(c, parseIntent('{"action":"connect_agent","params":{}}'))).toBe(true);
    expect(judge(c, parseIntent('{"action":"go","params":{"section":"people"}}'))).toBe(false);
    const root = CASES.find((x) => x.id === "root-user")!;
    expect(judge(root, parseIntent('{"none":"no"}'))).toBe(true);
    expect(judge(root, parseIntent('{"action":"go","params":{"section":"people"}}'))).toBe(false);
    const inv = CASES.find((x) => x.id === "invite-spoken-email")!;
    expect(judge(inv, parseIntent('{"action":"invite_person","params":{"email":"george.jackson@gmail.com"}}'))).toBe(true);
  });

  it("runs only with the key, and puts every call on the named agent and project", async () => {
    const t = await seedTenant("acme");
    const ann = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const proj = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "hub", kind: "repo", display_name: "Hub" }, Date.now());
    const historian = await createAgent(env.HUB_DB, { tenant: t, slug: "historian", display_name: "Historian", operator_id: ann.identity.id, role: "member", hubDomain: "pimwell.test" }, Date.now());
    let wrong = "";
    setModelFetchForTest(async (input, init) => {
      if (String(input).endsWith("/v1/models")) return Response.json({ data: [] });
      const b = JSON.parse(String(init!.body)) as { input: string };
      const text = b.input.endsWith("Person: take me to mail") ? (wrong = "x", '{"action":"go","params":{"section":"people"}}') : answerFor(b.input);
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 900, output_tokens: 20 } });
    });
    await addCredential(env.HUB_DB, env.HUB_SECRETS_KEY, { provider: "openai", label: "hub", secret: "sk-testAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaaa", tenant_id: null, created_by: null }, Date.now());
    const run = (key: string | null, body: unknown) => SELF.fetch("https://pimwell.test/internal/evals/intent", { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
    expect((await run(null, {})).status).toBe(401);
    expect((await run("nope", {})).status).toBe(401);
    expect((await run("test-eval-key", { attribute_to: "ann@example.com" })).status).toBe(400);
    const r = await run("test-eval-key", { attribute_to: historian.identity.email, project: "hub" });
    expect(r.status).toBe(200);
    const out = (await r.json()) as { passed: number; failed: number; results: Array<{ id: string; ok: boolean }> };
    expect(wrong).toBe("x");
    expect(out.failed).toBe(1);
    expect(out.results.find((x) => !x.ok)!.id).toBe("mail");
    expect(out.passed).toBe(CASES.length - 1);
    const rows = await env.HUB_DB.prepare("SELECT DISTINCT identity_id, project_id, client, tenant_id FROM model_call").all<{ identity_id: string; project_id: string; client: string; tenant_id: string }>();
    expect(rows.results).toEqual([{ identity_id: historian.identity.id, project_id: proj.id, client: "intent-eval", tenant_id: t.id }]);
    void cookieHeaders;
  });

  it("opens a project's status for \"what's going on\"", async () => {
    const t = await seedTenant("acme");
    const ann = await seedHuman("ann@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
    await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "skyledger", kind: "repo", display_name: "SkyLedger" }, Date.now());
    setModelFetchForTest(async (input) => String(input).endsWith("/v1/models") ? Response.json({ data: [] })
      : Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: '{"action":"open_project","params":{"project":"sky ledger","view":"status"}}' }] }] }));
    await addCredential(env.HUB_DB, env.HUB_SECRETS_KEY, { provider: "openai", label: "hub", secret: "sk-testAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaaa", tenant_id: null, created_by: null }, Date.now());
    const r = await SELF.fetch("https://acme.pimwell.test/do?q=what%27s%20going%20on%20with%20sky%20ledger", { headers: cookieHeaders(ann.token, "acme.pimwell.test"), redirect: "manual" });
    expect(r.headers.get("location")).toBe("/skyledger/status");
  });
});
