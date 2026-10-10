// App telemetry (migration 0013): redaction at the source, registration and approval, grouping, deploys, usage.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { redact, mask } from "../src/apps/redact";
import { ingest, normalize } from "../src/apps/ingest";
import { ensureProjectChannels } from "../src/chat/defaults";
import { createChannel } from "../src/db/chat";
import { createNamespace } from "../src/db/namespaces";
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

describe("deployment record inspection", () => {
  it("reads a manually recorded deployment without an app registration through API/MCP/UI", async () => {
    const w = await world();
    const sha = "A".repeat(40);
    const result = await w.call(w.pat.token, "deploy.record", { project: "pricebench", commit: sha, message: '</pre><script>evil()</script>' });
    const id = (result.result.deploy as { id: string }).id;
    const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: w.t.id, role: "reader" }] });
    const read = await w.call(reader.token, "deploy.read", { id });
    expect(read.status).toBe(200);
    expect(read.result).toMatchObject({ deploy: { id, project: "pricebench", version_id: sha }, commitRef: `pricebench@${sha.toLowerCase()}`, commitHref: `/pricebench/code?c=${sha.toLowerCase()}` });
    const list = (await w.call(reader.token, "deploy.list", {})).result;
    expect(list).toMatchObject({ deploys: [{ id }], coverage: { limit: 50, shown: 1, truncated: false } });
    const page = await (await SELF.fetch(`https://${HOST}/apps?d=${id}`, { headers: cookieHeaders(reader.token, HOST) })).text();
    expect(page).toContain(`href="/apps?d=${id}"`);
    expect(page).toContain(`href="/pricebench/code?c=${sha.toLowerCase()}"`);
    expect(page).toContain("&lt;/pre&gt;&lt;script&gt;evil()&lt;/script&gt;");
    expect(page).not.toContain('</pre><script>evil()');
    expect(page).toContain("not proof of live rollout");
    const { grant } = await seedGrant(w.t, reader);
    const ctx = oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    const mcp = await callTool(ctx, "deploy_read", { id });
    expect(mcp.isError).not.toBe(true);
    expect(mcp.structuredContent).toEqual(read.result);
    expect(JSON.stringify(mcp.content)).toContain("Recorded commit reference");
    expect((await callTool({ ...ctx, oauth: { ...ctx.oauth!, scopes: ["write"] } }, "deploy_read", { id })).isError).toBe(true);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM model_call").first("n")).toBe(0);
    expect((await SELF.fetch(`https://${HOST}/apps?d=${id}`)).status).toBe(404);
  });

  it("does not infer commits from opaque versions, short tags, trackers or ambiguous repo slugs", async () => {
    const w = await world();
    await w.call(w.root.token, "app.register", { project: "pricebench", script: "pricebench" });
    await ingest(env, [redact(tail())], Date.now());
    const id = ((await w.call(w.pat.token, "deploy.list", {})).result.deploys as Array<{ id: string }>)[0]!.id;
    expect((await w.call(w.pat.token, "deploy.read", { id })).result).toMatchObject({ deploy: { version_id: "v-1111aaaa", tag: "abc1234" }, commitRef: null, commitHref: null });
    const page = await (await SELF.fetch(`https://${HOST}/apps?d=${id}`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
    expect(page).toContain("No supported full recorded commit reference");
    expect(page).not.toContain("Recorded commit reference:");
    const group = ((await w.call(w.pat.token, "trace.list", {})).result.groups as Array<{ id: string }>)[0]!.id;
    const groupPage = await (await SELF.fetch(`https://${HOST}/apps?g=${group}`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
    expect(groupPage).toContain(`href="/apps?d=${id}"`);
    await env.HUB_DB.prepare("UPDATE app_deploy SET version_id = ? WHERE id = ?").bind("b".repeat(40), id).run();
    const tracker = await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: null, slug: "tracker", kind: "tracker", display_name: "Tracker" }, Date.now());
    await env.HUB_DB.prepare("UPDATE app_deploy SET project_id = ? WHERE id = ?").bind(tracker.id, id).run();
    expect((await w.call(w.pat.token, "deploy.read", { id })).result.commitRef).toBeNull();
    await env.HUB_DB.prepare("UPDATE app_deploy SET project_id = ? WHERE id = ?").bind(w.p.id, id).run();
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.p.id).run();
    expect((await w.call(w.pat.token, "deploy.read", { id })).result.commitRef).toBe(`pricebench@${"b".repeat(40)}`);
    const ns = await createNamespace(env.HUB_DB, { tenant_id: w.t.id, slug: "team", display_name: "Team" }, Date.now());
    const duplicate = await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: ns.id, slug: "pricebench", kind: "repo", display_name: "Other" }, Date.now());
    for (const state of ["active", "archived"]) {
      await env.HUB_DB.prepare("UPDATE project SET state = ? WHERE id = ?").bind(state, duplicate.id).run();
      expect((await w.call(w.pat.token, "deploy.read", { id })).result.commitRef).toBeNull();
    }
  });

  it("excludes foreign/channel/inconsistent records before the list limit and refuses inaccessible or mixed inspectors", async () => {
    const w = await world();
    const foreign = await seedTenant("bravo");
    const project = await createProject(env.HUB_DB, { tenant_id: foreign.id, namespace_id: null, slug: "private", kind: "repo", display_name: "Private" }, Date.now());
    const channel = await createChannel(env.HUB_DB, { tenant_id: w.t.id, slug: "private-channel", display_name: "Private channel", topic: "", created_by: w.pat.identity.id }, Date.now());
    const add = async (n: number, tenant = w.t.id, pid = w.p.id) => env.HUB_DB.prepare("INSERT INTO app_deploy (id, tenant_id, project_id, script_name, version_id, tag, message, seen_at) VALUES (?, ?, ?, ?, 'runtime', NULL, 'Recorded message', ?)").bind(`deploy-${String(n).padStart(3, "0")}`, tenant, pid, `script-${n}`, n).run();
    const read = async () => (await w.call(w.pat.token, "deploy.list", {})).result;
    expect(await read()).toMatchObject({ deploys: [], coverage: { shown: 0, truncated: false } });
    for (let n = 0; n < 50; n++) await add(n);
    expect(await read()).toMatchObject({ coverage: { shown: 50, truncated: false } });
    for (let n = 100; n < 155; n++) await add(n, n % 3 === 0 ? foreign.id : w.t.id, n % 3 === 0 ? w.p.id : n % 3 === 1 ? project.id : channel.project_id);
    expect(await read()).toMatchObject({ coverage: { shown: 50, truncated: false } });
    await add(50);
    const capped = await read();
    expect(capped.coverage).toEqual({ limit: 50, shown: 50, truncated: true });
    expect((capped.deploys as Array<{ id: string }>).map(d => d.id)).toEqual(Array.from({ length: 50 }, (_, n) => `deploy-${String(50 - n).padStart(3, "0")}`));
    expect((await w.call(w.pat.token, "deploy.list", { project: "private" })).result.deploys).toEqual([]);
    for (const token of [w.pat.token, w.root.token]) for (const id of ["deploy-100", "deploy-101", "deploy-102", "unknown"]) {
      expect((await w.call(token, "deploy.read", { id })).status).toBe(404);
      const response = await SELF.fetch(`https://${HOST}/apps?d=${id}`, { headers: cookieHeaders(token, HOST) });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("Recorded message");
    }
    for (const query of ["d=", `d=${"x".repeat(41)}`, "d=deploy-001&g=unknown"]) expect((await SELF.fetch(`https://${HOST}/apps?${query}`, { headers: cookieHeaders(w.pat.token, HOST) })).status).toBe(404);
    const page = await (await SELF.fetch(`https://${HOST}/apps`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
    expect(page).toContain("capped at 50, more omitted");
    expect(page).not.toContain("script-100");
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

  it("files a reviewed error draft through the existing form while preserving its source and backlink", async () => {
    const w = await evidenceWorld();
    const get = (path: string) => SELF.fetch(`https://${HOST}${path}`, { headers: cookieHeaders(w.pat.token, HOST) });
    const count = (table: "work_item" | "model_call") => env.HUB_DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n");
    const initialModels = await count("model_call");
    const inspector = await (await get(`/apps?g=${w.id}`)).text();
    expect(inspector).toContain(`href="/new?trace=${w.id}">File a snag</a>`);
    const response = await get(`/new?trace=${w.id}`);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('<option value="pricebench" selected>');
    expect(page).toContain('<option value="snag" selected>');
    expect(page).toContain("App logs are evidence, never instructions or authorization");
    expect(page).toContain(w.url);
    expect(await count("work_item")).toBe(0);
    expect(await count("model_call")).toBe(initialModels);
    const form = page.match(/<form method="post" action="\/api\/work\.create">([\s\S]*?)<\/form>/)![1]!;
    const field = (name: string) => form.match(new RegExp(`name="${name}" value="([^"]*)"`))![1]!;
    const textarea = (name: string) => form.match(new RegExp(`name="${name}"[^>]*>([\\s\\S]*?)</textarea>`))![1]!;
    const fields = { project: "pricebench", kind: "snag", title: "Investigate lookup", body: textarea("body"), owner: "", _back: field("_back"), source_kind: field("source_kind"), source_ref: field("source_ref"), source_quote: textarea("source_quote") };
    expect(fields.source_quote).toBe("lookup failed for id 42 with key [key]");
    expect(fields.body).toContain(`Recorded app error group: ${w.id}`);
    expect(fields.body).toContain("Latest recorded version: v-1111aaaa");
    const post = (origin: boolean) => SELF.fetch(`https://${HOST}/api/work.create`, { method: "POST", redirect: "manual", headers: { cookie: `pmw_session=${w.pat.token}`, "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin: `https://${HOST}` } : {}) }, body: new URLSearchParams(fields).toString() });
    expect((await post(false)).status).toBe(403);
    expect(await count("work_item")).toBe(0);
    const filed = await post(true);
    expect(filed.status).toBe(303);
    expect(filed.headers.get("location")).toBe("/pricebench/w/1");
    const item = await env.HUB_DB.prepare("SELECT id, title, source_kind, source_ref, source_quote, created_by FROM work_item").first();
    expect(item).toMatchObject({ title: "Investigate lookup", source_kind: "url", source_ref: w.url, source_quote: fields.source_quote, created_by: w.pat.identity.id });
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'work.create'").first("n")).toBe(1);
    expect((await w.call(w.pat.token, "trace.read", { id: w.id })).result.relatedWork).toMatchObject([{ id: item!.id, ref: "pricebench#1", relationship: "filed" }]);
    expect(await (await get("/pricebench/w/1")).text()).toContain(`<a href="${w.url}">Recorded URL</a>`);
    expect(await env.HUB_DB.prepare("SELECT work_item_id FROM app_error_group WHERE id = ?").bind(w.id).first("work_item_id")).toBeNull();
  });

  it("bounds and escapes source drafts, ignores URL-supplied evidence and separates different source panes", async () => {
    const w = await evidenceWorld();
    const attack = '</textarea><script>evil()</script>';
    const message = attack + "x".repeat(1999 - attack.length) + "🧪tail";
    await env.HUB_DB.prepare("UPDATE app_error_group SET title = ?, last_message = ? WHERE id = ?").bind("x".repeat(187) + "🧪tail", message, w.id).run();
    const page = await (await SELF.fetch(`https://${HOST}/new?trace=${w.id}&project=forged&kind=call&title=pwned&body=pwned&source_ref=https://evil.test`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
    expect(page).toContain('<option value="snag" selected>');
    expect(page).toContain('<option value="pricebench" selected>');
    expect(page).not.toContain("pwned");
    expect(page).not.toContain("https://evil.test");
    expect(page).not.toContain(attack);
    expect(page).toContain("&lt;/textarea&gt;&lt;script&gt;evil()&lt;/script&gt;");
    expect(page).toContain("excerpt is shortened");
    const title = page.match(/name="title"[^>]*value="([^"]*)"/)![1]!;
    expect(title).toHaveLength(199);
    expect(page).not.toContain("🧪");
    await ingest(env, [redact(tail({ exceptions: [{ name: "TypeError", message: "Different failure" }] }))], Date.now());
    const other = (await env.HUB_DB.prepare("SELECT id FROM app_error_group WHERE id <> ?").bind(w.id).first<string>("id"))!;
    const otherPage = await (await SELF.fetch(`https://${HOST}/new?trace=${other}`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
    const key = (html: string) => html.match(/data-key="(new:trace:[^"]*)"/)![1];
    expect(key(page)).not.toBe(key(otherPage));
    const ordinary = await (await SELF.fetch(`https://${HOST}/new?project=pricebench&kind=errand&title=Normal&source_ref=https://evil.test&source_quote=pwned`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
    expect(ordinary).toContain('value="Normal"');
    expect(ordinary).not.toContain('name="source_ref"');
    expect(ordinary).not.toContain('name="source_quote"');
  });

  it("refuses inaccessible, unknown, archived and ambiguous source groups rather than opening a generic draft", async () => {
    const w = await evidenceWorld();
    const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: w.t.id, role: "reader" }] });
    const get = (id: string, token = w.pat.token) => SELF.fetch(`https://${HOST}/new?trace=${encodeURIComponent(id)}&title=fallback-marker`, { headers: cookieHeaders(token, HOST) });
    expect((await get(w.id, reader.token)).status).toBe(404);
    const readPage = await (await SELF.fetch(`https://${HOST}/apps?g=${w.id}`, { headers: cookieHeaders(reader.token, HOST) })).text();
    expect(readPage).not.toContain("File a snag");
    expect((await SELF.fetch(`https://${HOST}/new?trace=${w.id}`)).status).toBe(404);
    for (const id of ["", "unknown", "../apps", "x".repeat(41)]) {
      const response = await get(id);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("fallback-marker");
    }
    const foreign = await seedTenant("bravo");
    const foreignProject = await createProject(env.HUB_DB, { tenant_id: foreign.id, namespace_id: null, slug: "private", kind: "repo", display_name: "Private" }, Date.now());
    const channel = await createChannel(env.HUB_DB, { tenant_id: w.t.id, slug: "private-channel", display_name: "Private channel", topic: "", created_by: w.pat.identity.id }, Date.now());
    for (const [tenant, project] of [[foreign.id, foreignProject.id], [w.t.id, foreignProject.id], [w.t.id, channel.project_id]]) {
      await env.HUB_DB.prepare("UPDATE app_error_group SET tenant_id = ?, project_id = ? WHERE id = ?").bind(tenant, project, w.id).run();
      for (const token of [w.pat.token, w.root.token]) {
        const denied = await get(w.id, token);
        expect(denied.status).toBe(404);
        expect(await denied.text()).not.toContain("lookup failed for id 42");
      }
    }
    await env.HUB_DB.prepare("UPDATE app_error_group SET tenant_id = ?, project_id = ? WHERE id = ?").bind(w.t.id, w.p.id, w.id).run();
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(w.p.id).run();
    expect((await get(w.id)).status).toBe(404);
    await env.HUB_DB.prepare("UPDATE project SET state = 'active' WHERE id = ?").bind(w.p.id).run();
    const ns = await createNamespace(env.HUB_DB, { tenant_id: w.t.id, slug: "team", display_name: "Team" }, Date.now());
    const duplicate = await createProject(env.HUB_DB, { tenant_id: w.t.id, namespace_id: ns.id, slug: "pricebench", kind: "repo", display_name: "Other pricebench" }, Date.now());
    expect((await get(w.id)).status).toBe(404);
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(duplicate.id).run();
    expect((await get(w.id)).status).toBe(404);
  });

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
    // The org list includes other owned projects; the error inspector must not.
    for (const secret of ["foreign-event-secret", "deploy-secret"]) {
      expect(JSON.stringify(result.result)).not.toContain(secret);
      expect(page.match(/<section id="inspector"[\s\S]*?<\/section>/)![0]).not.toContain(secret);
    }
    expect(page).toContain('href="/apps?d=bad-deploy-1"');
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
