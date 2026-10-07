// App telemetry (migration 0013): redaction at the source, registration and approval, grouping, deploys, usage.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { redact, mask } from "../src/apps/redact";
import { ingest, normalize } from "../src/apps/ingest";
import { ensureProjectChannels } from "../src/chat/defaults";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
const tail = (over: Record<string, unknown> = {}) => ({
  scriptName: "pricebench", outcome: "ok", eventTimestamp: Date.now(), scriptVersion: { id: "v-1111aaaa", tag: "abc1234", message: "Fix prices" },
  event: { request: { url: "https://pb.example.com/api/price?ndc=123&token=pms_secretsecretsecret", method: "GET", headers: { "cf-ray": "ray1", authorization: "Bearer abcdefghijklmnop", cookie: "s=1" } }, response: { status: 200 } },
  logs: [{ level: "log", message: ["hello pat@example.com"] }, { level: "error", message: ["lookup failed for id 42 with key sk-abcdefghijkl"] },
    { level: "log", message: [JSON.stringify({ pimwell: "ai_usage", provider: "openai", model: "m-1", input_tokens: 100, output_tokens: 20 })] }],
  exceptions: [], ...over,
});

async function world() {
  const t = await seedTenant("acme");
  const p = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "pricebench", kind: "repo", display_name: "PriceBench" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const root = await seedHuman("root@example.com", { is_root: true, memberships: [{ tenant_id: t.id, role: "admin" }] });
  await ensureProjectChannels(env.HUB_DB, { tenant_id: t.id, slug: "pricebench", display_name: "PriceBench" }, pat.identity.id, Date.now());
  const call = async (token: string, verb: string, body: unknown, host = HOST) => {
    const r = await apiPost(host, verb, body, cookieHeaders(token, host));
    return { status: r.status, ...((await r.json()) as { result: Record<string, unknown> }) };
  };
  return { t, p, pat, root, call };
}

describe("redaction at the source", () => {
  it("keeps paths without query values, no headers but the ray, only warnings and errors, masked", () => {
    const e = redact(tail())!;
    expect(e.path).toBe("/api/price?ndc=…&token=…");
    expect(e.ray).toBe("ray1");
    expect(JSON.stringify(e)).not.toMatch(/pms_secret|abcdefghijklmnop|pat@example\.com|sk-abcdefghijkl|cookie/);
    expect(e.logs).toEqual([{ level: "error", text: "lookup failed for id 42 with key [key]" }]);
    expect(e.usage).toEqual([{ provider: "openai", model: "m-1", input_tokens: 100, output_tokens: 20, cached_tokens: null, cost_usd: null, purpose: null }]);
    expect(mask('password: "hunter2" token=abc eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4')).toBe('password: [redacted]" token=[redacted] [jwt]');
    expect(redact({ scriptName: null } as never)).toBeNull();
  });
});

describe("app telemetry", () => {
  it("drops unregistered and pending apps, and counts approved ones", async () => {
    const w = await world();
    expect(await ingest(env, [redact(tail())], Date.now())).toEqual({ accepted: 0, dropped: 1 });
    expect((await w.call(w.pat.token, "app.register", { project: "pricebench", script: "pricebench" })).result).toMatchObject({ state: "pending" });
    expect((await ingest(env, [redact(tail())], Date.now())).accepted).toBe(0);
    expect((await w.call(w.root.token, "app.register", { project: "pricebench", script: "pricebench" })).result).toMatchObject({ state: "active" });
    expect((await ingest(env, [redact(tail()), redact(tail({ logs: [{ level: "error", message: ["lookup failed for id 77 with key sk-zzzzzzzzzzzz"] }] }))], Date.now())).accepted).toBe(2);
    const groups = (await env.HUB_DB.prepare("SELECT kind, count, title FROM app_error_group").all()).results;
    expect(groups).toEqual([{ kind: "error", count: 2, title: "lookup failed for id 42 with key [key]" }]);
    expect((await env.HUB_DB.prepare("SELECT version_id, tag FROM app_deploy").all()).results).toEqual([{ version_id: "v-1111aaaa", tag: "abc1234" }]);
    expect((await env.HUB_DB.prepare("SELECT requests FROM app_stat").first<{ requests: number }>())!.requests).toBe(2);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n, MIN(source) AS s, MIN(client) AS c FROM model_call").first())).toEqual({ n: 1, s: "app", c: "pricebench" });
    expect(await ingest(env, "nonsense", Date.now())).toEqual({ accepted: 0, dropped: 0 });
  });

  it("groups the same failure with different numbers, and keeps different failures apart", () => {
    expect(normalize("Timeout after 3000ms on id 9f8e7d6c5b4a3210")).toBe(normalize("Timeout after 5000ms on id 0123456789abcdef"));
    expect(normalize("Timeout")).not.toBe(normalize("Not found"));
  });

  it("refuses an app another organization already has, and lists traces and deploys", async () => {
    const w = await world();
    await w.call(w.root.token, "app.register", { project: "pricebench", script: "pricebench" });
    const other = await seedTenant("bravo");
    await createProject(env.HUB_DB, { tenant_id: other.id, namespace_id: null, slug: "x", kind: "repo", display_name: "X" }, Date.now());
    const eve = await seedHuman("eve@example.com", { memberships: [{ tenant_id: other.id, role: "admin" }] });
    expect((await w.call(eve.token, "app.register", { project: "x", script: "pricebench" }, "bravo.pimwell.test")).status).toBe(409);
    expect((await w.call(w.pat.token, "app.register", { project: "pricebench", script: "Bad Name" })).status).toBe(400);
    await ingest(env, [redact(tail({ exceptions: [{ name: "TypeError", message: "x is undefined" }] }))], Date.now());
    const traces = await w.call(w.pat.token, "trace.list", {});
    const list = traces.result.groups as Array<{ id: string; kind: string }>;
    expect(list.map((g) => g.kind).sort()).toEqual(["error", "exception"]);
    const one = await w.call(w.pat.token, "trace.read", { id: list[0]!.id });
    expect((one.result.events as unknown[]).length).toBe(1);
    expect(((await w.call(w.pat.token, "deploy.list", {})).result.deploys as unknown[]).length).toBe(1);
    const page = await (await SELF.fetch(`https://${HOST}/apps`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
    expect(page).toContain("<code>pricebench</code>");
    expect(page).toContain("x is undefined");
  });

  it("shows root the registrations to approve, and nobody else", async () => {
    const w = await world();
    await w.call(w.pat.token, "app.register", { project: "pricebench", script: "agentfeed" });
    const page = await (await SELF.fetch("https://pimwell.test/admin/apps", { headers: cookieHeaders(w.root.token, "pimwell.test") })).text();
    expect(page).toContain("<code>agentfeed</code>");
    expect(page).toContain('action="/api/app.approve"');
    expect((await SELF.fetch("https://pimwell.test/admin/apps", { headers: cookieHeaders(w.pat.token, "pimwell.test") })).status).toBe(404);
  });

  it("serves the setup instructions publicly, as Markdown for agents", async () => {
    const res = await SELF.fetch("https://pimwell.test/setup");
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const md = await res.text();
    expect(md).toContain('"tail_consumers": [{ "service": "pimwell-tail" }]');
    expect(md).toContain("usage_report");
    expect(md).toContain("https://<org>.pimwell.test/mcp");
  });
});
