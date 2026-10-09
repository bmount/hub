import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { introspect } from "../src/http/internal";
import { internalBacklinks } from "../src/http/internalBacklinks";
import { intentEvalRoute } from "../src/intent/evalRoute";
import { MAX_INTERNAL_BODY_BYTES, MAX_INTENT_EVAL_BODY_BYTES } from "../src/http/body";
import { createGitSession } from "../src/db/sessions";
import { addCredential } from "../src/models/store";
import { setModelFetchForTest } from "../src/models/providers";
import { CASES } from "../src/intent/evals";
import { RATE_RULES } from "../src/rate";
import { sha256Hex } from "../src/ids";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

const enc = new TextEncoder();
afterEach(() => { setModelFetchForTest(null); vi.restoreAllMocks(); });
const routes: Array<{ name: "introspect" | "backlinks" | "eval"; path: string; limit: number; headers: Record<string, string>; run: (r: Request, e: typeof env) => Promise<Response> }> = [
  { name: "introspect", path: "/internal/introspect", limit: MAX_INTERNAL_BODY_BYTES, headers: { "x-hub-internal": "test-internal-secret" }, run: introspect },
  { name: "backlinks", path: "/internal/backlinks", limit: MAX_INTERNAL_BODY_BYTES, headers: { "x-hub-internal": "test-internal-secret" }, run: internalBacklinks },
  { name: "eval", path: "/internal/evals/intent", limit: MAX_INTENT_EVAL_BODY_BYTES, headers: { authorization: "Bearer test-eval-key" }, run: intentEvalRoute },
];
type Route = typeof routes[number];
function streamed(route: Route, text: string, extra: Record<string, string> = {}, signal?: AbortSignal) {
  const bytes = enc.encode(text);
  let offset = 0, pulls = 0, cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulls++;
      if (offset === bytes.length) { c.close(); return; }
      const end = Math.min(offset + 1024, bytes.length);
      c.enqueue(bytes.subarray(offset, end)); offset = end;
    },
    cancel() { cancelled++; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  const request = new Request(`https://pimwell.test${route.path}`, { method: "POST", headers: { "content-type": "application/json", ...route.headers, ...extra }, body, signal });
  return { request, stats: () => ({ pulls, cancelled }) };
}
async function world() {
  const tenant = await seedTenant("acme");
  const human = await seedHuman("pat@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const git = await createGitSession(env.HUB_DB, { identity_id: human.identity.id, tenant_id: tenant.id, label: "laptop" }, Date.now());
  const agent = await seedAgent(tenant, human.identity);
  let modelCalls = 0;
  setModelFetchForTest(async (input) => {
    if (String(input).endsWith("/v1/models")) return Response.json({ data: [] });
    modelCalls++;
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: '{"none":"bounded fixture"}' }] }], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  await addCredential(env.HUB_DB, env.HUB_SECRETS_KEY, { provider: "openai", label: "test", secret: "sk-testAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaaa", tenant_id: null, created_by: null }, Date.now());
  const bodies = {
    introspect: JSON.stringify({ token: git.token, tenant: "acme" }),
    backlinks: JSON.stringify({ tenant: "acme", principal: human.identity.id, kind: "ticket", key: "site#k7q2" }),
    eval: JSON.stringify({ attribute_to: agent.agent.identity.email, only: [CASES[0]!.id], max: 1 }),
  };
  const effects = async () => ({
    modelCalls,
    sessions: (await env.HUB_DB.prepare("SELECT * FROM session").all()).results,
    events: (await env.HUB_DB.prepare("SELECT * FROM event").all()).results,
    models: (await env.HUB_DB.prepare("SELECT * FROM model_call").all()).results,
  });
  return { bodies, effects };
}
const padded = (body: string, size: number) => body + " ".repeat(size - enc.encode(body).length);

describe("internal actual-byte ingress", () => {
  it.each(routes)("bounds $name before credential/reference lookups or model effects", async (route) => {
    const w = await world();
    const before = await w.effects();
    const prepare = vi.spyOn(env.HUB_DB, "prepare");
    const s = streamed(route, padded(w.bodies[route.name], route.limit + 1), { "content-length": "1", "transfer-encoding": "chunked" });
    const res = await route.run(s.request, env);
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    expect(s.stats().cancelled).toBe(1);
    expect(s.request.body!.locked).toBe(false);
    expect(await w.effects()).toEqual(before);
    if (route.name !== "eval") expect(await res.json()).toEqual({ ok: false });
  });

  it.each(routes)("$name rejects absent, zero and malformed length overflow using UTF-8 bytes", async (route) => {
    for (const extra of [{}, { "content-length": "0" }, { "content-length": "bad" }] as Record<string, string>[]) {
      const s = streamed(route, "界".repeat(Math.floor(route.limit / 3) + 1), extra);
      expect((await route.run(s.request, env)).status).toBe(413);
      expect(s.stats().cancelled).toBe(1);
      expect(s.request.body!.locked).toBe(false);
    }
  });

  it.each(routes)("$name rejects a declared oversize without pulling", async (route) => {
    const s = streamed(route, "{}", { "content-length": String(route.limit + 1) });
    expect((await route.run(s.request, env)).status).toBe(413);
    expect(s.stats()).toEqual({ pulls: 0, cancelled: 1 });
  });

  it.each(routes)("$name authentication denials precede reads", async (route) => {
    const variations: Record<string, string>[] = route.name === "eval"
      ? [{ authorization: "" }, { authorization: "Bearer wrong" }, { host: "acme.pimwell.test" }]
      : [{ "x-hub-internal": "" }, { "x-hub-internal": "wrong" }, { "cf-connecting-ip": "198.51.100.7" }];
    for (const extra of variations) {
      const s = streamed(route, "x".repeat(route.limit + 1), extra);
      expect([401, 404]).toContain((await route.run(s.request, env)).status);
      expect(s.stats().pulls).toBe(0);
      expect(s.request.bodyUsed).toBe(false);
    }
    const closed = streamed(route, "{}");
    const e = route.name === "eval" ? { ...env, EVAL_KEY: undefined } : { ...env, HUB_INTERNAL_SECRET: undefined };
    expect((await route.run(closed.request, e)).status).toBe(404);
    expect(closed.stats().pulls).toBe(0);
  });

  it.each(routes)("$name safely refuses errors and cancellation without effects", async (route) => {
    const w = await world();
    const before = await w.effects();
    const original = streamed(route, "{}").request;
    const broken = new Request(original.url, { method: "POST", headers: original.headers, body: new ReadableStream({ pull(c) { c.error(new Error("private-stream-secret")); } }) });
    const res = await route.run(broken, env);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("private-stream-secret");
    const controller = new AbortController(); controller.abort();
    const s = streamed(route, "{}", {}, controller.signal);
    expect((await route.run(s.request, env)).status).toBe(400);
    expect(s.stats().pulls).toBe(0);
    expect(s.request.body!.locked).toBe(false);
    expect(await w.effects()).toEqual(before);
  });

  it.each(routes)("$name preserves bounded malformed input refusal", async (route) => {
    const prepare = vi.spyOn(env.HUB_DB, "prepare");
    for (const text of ["{bad", "null", "[]", '"string"', "1"]) {
      const res = await route.run(streamed(route, text).request, env);
      expect(res.status).toBe(route.name === "eval" ? 400 : 200);
      if (route.name !== "eval") expect(await res.json()).toEqual({ ok: false });
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(routes)("$name accepts exactly its byte cap with valid JSON and forged framing", async (route) => {
    const w = await world();
    const s = streamed(route, padded(w.bodies[route.name], route.limit), { "content-length": "0", "transfer-encoding": "chunked" });
    const res = await route.run(s.request, env);
    expect(res.status).toBe(200);
    const out = await res.json() as Record<string, unknown>;
    if (route.name === "eval") {
      expect((out.results as unknown[]).length).toBe(1);
      const effects = await w.effects();
      expect(effects.modelCalls).toBe(1);
      expect(effects.models).toHaveLength(1);
      expect(effects.events.some((e) => e.kind === "eval.run")).toBe(true);
    } else {
      expect(out.ok).toBe(true);
      if (route.name === "introspect") expect(JSON.stringify(out)).not.toContain(JSON.parse(w.bodies.introspect).token);
      else expect(out).toEqual({ ok: true, count: 0, items: [] });
    }
    expect(s.stats().cancelled).toBe(0);
    expect(s.request.body!.locked).toBe(false);
  });

  it.each(routes)("production entry bounds $name", async (route) => {
    const s = streamed(route, "x".repeat(route.limit + 1));
    const res = await worker.fetch(s.request, env, createExecutionContext());
    expect(res.status).toBe(413);
    expect(s.stats().cancelled).toBe(1);
  });

  it("eval run rate denial precedes reading", async () => {
    const rule = RATE_RULES.eval_runs;
    const now = Date.now(), window = Math.floor(now / rule.windowMs);
    await env.RATE.put(`rl:eval_runs:${window}:${await sha256Hex("intent")}`, String(rule.limit));
    const s = streamed(routes[2]!, "x".repeat(MAX_INTENT_EVAL_BODY_BYTES + 1));
    expect((await intentEvalRoute(s.request, env)).status).toBe(429);
    expect(s.stats().pulls).toBe(0);
    expect(s.request.bodyUsed).toBe(false);
  });
});
