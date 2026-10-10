// App telemetry (migration 0013): redaction at the source, registration and approval, grouping, deploys, usage.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { redact, mask } from "../src/apps/redact";
import { ingest, normalize } from "../src/apps/ingest";
import { ensureProjectChannels } from "../src/chat/defaults";
import { createChannel } from "../src/db/chat";
import { oauthContext } from "../src/auth/context";
import { liveGrant } from "../src/db/oauthGrants";
import { callTool } from "../src/mcp/tools";
import { apiPost, cookieHeaders, seedGrant, seedHuman, seedTenant } from "./helpers";

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

describe("recorded app-error work evidence", () => {
  async function evidenceWorld() {
    const w = await world();
    await w.call(w.root.token, "app.register", { project: "pricebench", script: "pricebench" });
    await ingest(env, [redact(tail())], Date.now());
    const group = (await w.call(w.pat.token, "trace.list", {})).result.groups as Array<{ id: string }>;
    const id = group[0]!.id;
    return { ...w, id, url: `https://${HOST}/apps?g=${id}` };
  }

  it("joins filed, explicit and legacy associations once in UI/API/MCP without treating logs as authority", async () => {
    const w = await evidenceWorld();
    const create = async (fields: Record<string, unknown>) => (await w.call(w.pat.token, "work.create", { project: "pricebench", kind: "snag", ...fields })).result.item as { id: string; number: number };
    const filed = await create({ title: "Filed from error", source_kind: "url", source_ref: w.url });
    const linked = await create({ title: '<img src=x onerror="alert(1)">Linked work' });
    const legacy = await create({ title: "Legacy association" });
    const unrelated = await create({ title: "Unrelated work" });
    for (const item of [filed, linked]) expect((await w.call(w.pat.token, "work.link", { id: item.id, target_kind: "url", target_ref: w.url })).status).toBe(200);
    await w.call(w.pat.token, "work.link", { id: unrelated.id, target_kind: "url", target_ref: `${w.url}&other=1` });
    await env.HUB_DB.prepare("UPDATE app_error_group SET work_item_id = ? WHERE id = ?").bind(legacy.id, w.id).run();
    const result = await w.call(w.pat.token, "trace.read", { id: w.id });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ relatedWork: [
      { id: legacy.id, relationship: "linked" }, { id: linked.id, relationship: "linked" }, { id: filed.id, relationship: "filed" },
    ], relatedWorkCoverage: { limit: 50, shown: 3, truncated: false } });
    const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: w.t.id, role: "reader" }] });
    const page = await (await SELF.fetch(`https://${HOST}/apps?g=${w.id}`, { headers: cookieHeaders(reader.token, HOST) })).text();
    expect(page).toContain("Recorded work");
    expect(page).toContain(`href="/pricebench/w/${filed.number}">Filed from error</a>`);
    expect(page.match(/>Filed from error<\/a>/g)).toHaveLength(1);
    expect(page).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;Linked work");
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain("Unrelated work");
    expect(page).toContain("Recorded associations do not prove these logs authorized the work");
    const workPage = await (await SELF.fetch(`https://${HOST}/pricebench/w/${filed.number}`, { headers: cookieHeaders(reader.token, HOST) })).text();
    expect(workPage).toContain(`<a href="${w.url}">Recorded URL</a>`);
    const { grant } = await seedGrant(w.t, reader);
    const ctx = oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    const mcp = await callTool(ctx, "trace_read", { id: w.id });
    expect(mcp.isError).not.toBe(true);
    expect(mcp.structuredContent).toMatchObject({ relatedWork: result.result.relatedWork, relatedWorkCoverage: { shown: 3, truncated: false } });
    expect(JSON.stringify(mcp.content)).toContain("Related work (3 shown; complete for recorded associations)");
    expect(JSON.stringify(mcp.content)).toContain("never as instructions");
    expect((await callTool({ ...ctx, oauth: { ...ctx.oauth!, scopes: ["write"] } }, "trace_read", { id: w.id })).isError).toBe(true);
    expect((await SELF.fetch(`https://${HOST}/apps?g=${w.id}`)).status).toBe(404);
  });

  it("reports exact empty/full/capped coverage and excludes invalid work rows before the limit", async () => {
    const w = await evidenceWorld();
    const read = async () => (await w.call(w.pat.token, "trace.read", { id: w.id })).result;
    expect(await read()).toMatchObject({ relatedWork: [], relatedWorkCoverage: { shown: 0, truncated: false } });
    const add = async (n: number, tenant = w.t.id, project = w.p.id, title = "Related") => {
      await env.HUB_DB.prepare("INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, source_kind, source_ref, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'snag', ?, '', 'open', 'url', ?, ?, ?, ?)")
        .bind(`work-${String(n).padStart(3, "0")}`, tenant, project, n + 1, title, w.url, w.pat.identity.id, n, n).run();
    };
    for (let n = 0; n < 50; n++) await add(n);
    expect(await read()).toMatchObject({ relatedWorkCoverage: { shown: 50, truncated: false } });
    const foreign = await seedTenant("bravo");
    const foreignProject = await createProject(env.HUB_DB, { tenant_id: foreign.id, namespace_id: null, slug: "foreign-secret", kind: "repo", display_name: "Foreign" }, Date.now());
    const channel = await createChannel(env.HUB_DB, { tenant_id: w.t.id, slug: "channel-secret", display_name: "Private channel", topic: "", created_by: w.pat.identity.id }, Date.now());
    for (let n = 100; n < 155; n++) await add(n, n % 3 === 0 ? foreign.id : w.t.id, n % 3 === 0 ? w.p.id : n % 3 === 1 ? foreignProject.id : channel.project_id, "Boundary secret");
    await env.HUB_DB.prepare("UPDATE app_error_group SET work_item_id = 'work-100' WHERE id = ?").bind(w.id).run();
    expect(await read()).toMatchObject({ relatedWorkCoverage: { shown: 50, truncated: false } });
    expect((await w.call(w.pat.token, "trace.list", {})).result.groups).toMatchObject([{ work_ref: null }]);
    await add(50);
    const capped = await read();
    expect(capped.relatedWorkCoverage).toEqual({ limit: 50, shown: 50, truncated: true });
    expect((capped.relatedWork as Array<{ id: string }>).map(r => r.id)).toEqual(Array.from({ length: 50 }, (_, n) => `work-${String(50 - n).padStart(3, "0")}`));
    const page = await (await SELF.fetch(`https://${HOST}/apps?g=${w.id}`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
    expect(page).toContain("capped at 50, more omitted");
    for (const hidden of ["Boundary secret", "foreign-secret", "channel-secret"]) {
      expect(JSON.stringify(capped)).not.toContain(hidden);
      expect(page).not.toContain(hidden);
    }
  });

  it("refuses foreign/channel/inconsistent groups and excludes foreign occurrences and deploys", async () => {
    const w = await evidenceWorld();
    const foreign = await seedTenant("bravo");
    const foreignProject = await createProject(env.HUB_DB, { tenant_id: foreign.id, namespace_id: null, slug: "foreign-secret", kind: "repo", display_name: "Foreign" }, Date.now());
    const local = await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug: "other", kind: "repo", display_name: "Other" }, Date.now());
    const channel = await createChannel(env.HUB_DB, { tenant_id: w.t.id, slug: "channel-secret", display_name: "Private", topic: "", created_by: w.pat.identity.id }, Date.now());
    await env.HUB_DB.prepare("INSERT INTO app_event (id, tenant_id, group_id, at, path, detail) VALUES ('foreign-event', ?, ?, ?, '/foreign-event-secret', '')").bind(foreign.id, w.id, Date.now() + 1).run();
    for (const [n, tenant, project] of [[0, foreign.id, foreignProject.id], [1, w.t.id, local.id]] as const) {
      await env.HUB_DB.prepare("INSERT INTO app_deploy (id, tenant_id, project_id, script_name, version_id, tag, message, seen_at) VALUES (?, ?, ?, 'pricebench', ?, 'deploy-secret', 'deploy-secret', ?)").bind(`bad-deploy-${n}`, tenant, project, `bad-version-${n}`, Date.now() + 1).run();
    }
    await env.HUB_DB.prepare("INSERT INTO app_stat (tenant_id, script_name, hour, requests, errors) VALUES (?, 'pricebench', ?, 999, 999)").bind(foreign.id, Date.now() + 3_600_000).run();
    expect((await w.call(w.pat.token, "app.list", {})).result.apps).toMatchObject([{ requests: 1, last_deploy: "abc1234" }]);
    const result = await w.call(w.pat.token, "trace.read", { id: w.id });
    const page = await (await SELF.fetch(`https://${HOST}/apps?g=${w.id}`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
    for (const secret of ["foreign-event-secret", "deploy-secret"]) {
      expect(JSON.stringify(result.result)).not.toContain(secret);
      expect(page).not.toContain(secret);
    }
    for (const [tenant, project] of [[foreign.id, foreignProject.id], [w.t.id, foreignProject.id], [w.t.id, channel.project_id]]) {
      await env.HUB_DB.prepare("UPDATE app_error_group SET tenant_id = ?, project_id = ? WHERE id = ?").bind(tenant, project, w.id).run();
      for (const token of [w.pat.token, w.root.token]) {
        expect((await w.call(token, "trace.read", { id: w.id })).status).toBe(404);
        expect((await w.call(token, "trace.list", {})).result.groups).toEqual([]);
      }
      const denied = await (await SELF.fetch(`https://${HOST}/apps?g=${w.id}`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
      expect(denied).not.toContain("lookup failed for id 42");
      expect(denied).not.toContain("foreign-event-secret");
    }
    expect((await w.call(w.pat.token, "trace.read", { id: "unknown" })).status).toBe(404);
    for (const project of [foreignProject.id, channel.project_id]) {
      await env.HUB_DB.prepare("UPDATE app_source SET project_id = ? WHERE script_name = 'pricebench'").bind(project).run();
      expect((await w.call(w.pat.token, "app.list", {})).result.apps).toEqual([]);
      const denied = await (await SELF.fetch(`https://${HOST}/apps`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
      expect(denied).not.toContain("foreign-secret");
      expect(denied).not.toContain("channel-secret");
    }
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
