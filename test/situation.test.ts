// Situations in, the truth out: a read-only investigation with tools, a diagnosis in a fixed shape, and the outcome.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setModelFetchForTest } from "../src/models/providers";
import { addCredential } from "../src/models/store";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { ulid } from "../src/ids";
import type { Identity, Tenant } from "../src/db/types";

async function seedSituation(tenant: Tenant, identity: Identity) {
  const now = Date.now();
  const thread = ulid(now);
  const id = ulid(now);
  await env.HUB_DB.prepare(`INSERT INTO assistant_thread (id, tenant_id, identity_id, title, scopes, created_at, updated_at)
    VALUES (?, ?, ?, 'Investigation', 'read', ?, ?)`).bind(thread, tenant.id, identity.id, now, now).run();
  await env.HUB_DB.prepare(`INSERT INTO situation (id, tenant_id, identity_id, thread_id, title, question, report, created_at)
    VALUES (?, ?, ?, ?, 'Missing signups', 'Why did signups fall?', ?, ?)`)
    .bind(id, tenant.id, identity.id, thread, "Cause: unknown\nEvidence: none\nEstimate: unknown\nConfidence: low", now).run();
  return id;
}

async function savedSituation(id: string) {
  return (await env.HUB_DB.prepare("SELECT * FROM situation WHERE id = ?").bind(id).first())!;
}

const HOST = "acme.pimwell.test";
afterEach(() => setModelFetchForTest(null));

describe("situations", () => {
  it("investigates with tools, answers in sections, keeps the report, and records what was true", async () => {
    const t = await seedTenant("acme");
    const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
    const sent: Array<{ instructions: string; tools: Array<{ name: string }> }> = [];
    setModelFetchForTest(async (input, init) => {
      if (String(input).endsWith("/v1/models")) return Response.json({ data: [{ id: "gpt-6.1-sol" }] });
      const b = JSON.parse(String(init!.body)) as { instructions: string; tools: Array<{ name: string }>; input: Array<Record<string, unknown>> };
      sent.push(b);
      if (!b.input.some((i) => i.type === "function_call_output")) return Response.json({ output: [{ type: "function_call", call_id: "c", name: "work_list", arguments: "{}" }], usage: { input_tokens: 10, output_tokens: 2 } });
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "Cause: the record doesn't show it.\nEvidence:\n- none\nWho should act: ada\nEstimate: unknown\nConfidence: low" }] }], usage: { input_tokens: 20, output_tokens: 20 } });
    });
    await addCredential(env.HUB_DB, env.HUB_SECRETS_KEY, { provider: "openai", label: "hub", secret: "sk-testAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaaa", tenant_id: null, created_by: null }, Date.now());
    const h = cookieHeaders(ada.token, HOST);
    const r = await apiPost(HOST, "situation.open", { text: "Signups dropped last week. Why?" }, h);
    expect(r.status, await r.clone().text()).toBe(200);
    const s = ((await r.json()) as { result: { id: string; report: string; steps: number } }).result;
    expect(s.report).toContain("Cause: the record doesn't show it.");
    expect(s.steps).toBe(1);
    expect(sent[0]!.instructions).toContain("Confidence: low, medium or high");
    expect(sent[0]!.tools.map((x) => x.name)).not.toContain("work_create");
    expect((await apiPost(HOST, "situation.open", { text: "short" }, h)).status).toBe(400);
    expect((await apiPost(HOST, "situation.resolve", { id: s.id, outcome: "A broken signup form after deploy abc1234." }, h)).status).toBe(200);
    const page = await (await SELF.fetch(`https://${HOST}/situations?s=${s.id}`, { headers: h })).text();
    expect(page).toContain("Signups dropped last week");
    expect(page).toContain("A broken signup form");
    expect(page).toContain("Original diagnosis");
    expect(page).toContain("Recorded by ada");
    expect(page).toContain("Member-reported, not independently verified");
    expect(page).not.toContain('action="/api/situation.resolve"');
    const form = await SELF.fetch(`https://${HOST}/api/situation.open`, { method: "POST", redirect: "manual", headers: { ...h, origin: `https://${HOST}`, "content-type": "application/x-www-form-urlencoded" }, body: "text=Errors%20spiked%20this%20morning&_back=%40result" });
    expect(form.status).toBe(303);
    expect(form.headers.get("location")).toMatch(/^\/situations\?s=/);
  });

  it("keeps the original diagnosis and attributed first outcome unchanged across exact retries and conflicts", async () => {
    const tenant = await seedTenant("acme");
    const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
    const other = await seedHuman("other@example.com", { memberships: [{ tenant_id: tenant.id, role: "admin" }] });
    const id = await seedSituation(tenant, ada.identity);
    const before = await savedSituation(id);
    const headers = cookieHeaders(ada.token, HOST);
    const outcome = "Deploy abc123 broke the form; fixed by project#12.";
    expect((await apiPost(HOST, "situation.resolve", { id, outcome: `  ${outcome}\n` }, headers)).status).toBe(200);
    const first = await savedSituation(id);
    expect(first).toEqual({ ...before, outcome, outcome_by: ada.identity.id, outcome_at: expect.any(Number) });
    expect((await apiPost(HOST, "situation.resolve", { id, outcome }, headers)).status).toBe(200);
    expect(await savedSituation(id)).toEqual(first);
    for (const [token, text] of [[ada.token, "Actually, no incident."], [other.token, outcome], [other.token, "Different finding"]]) {
      expect((await apiPost(HOST, "situation.resolve", { id, outcome: text }, cookieHeaders(token!, HOST))).status).toBe(409);
      expect(await savedSituation(id)).toEqual(first);
    }
    const list = await apiPost(HOST, "situation.list", {}, headers);
    expect((await list.json() as { result: { situations: unknown[] } }).result.situations).toEqual([
      expect.objectContaining({ id, report: before.report, outcome, outcome_by: ada.identity.id, outcome_at: first.outcome_at, outcome_who: "ada" }),
    ]);
  });

  it("atomically keeps one outcome when competing recorders submit concurrently", async () => {
    const tenant = await seedTenant("acme");
    const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
    const ben = await seedHuman("ben@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
    const id = await seedSituation(tenant, ada.identity);
    const report = (await savedSituation(id)).report;
    const results = await Promise.all([ada, ben].map((actor) =>
      apiPost(HOST, "situation.resolve", { id, outcome: actor.identity.display_name }, cookieHeaders(actor.token, HOST))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results[0]!.status === 200 ? ada : ben;
    expect(await savedSituation(id)).toMatchObject({ report, outcome: winner.identity.display_name, outcome_by: winner.identity.id });
  });

  it("allows concurrent identical retries only for the original recorder without changing time", async () => {
    const tenant = await seedTenant("acme");
    const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
    const id = await seedSituation(tenant, ada.identity);
    const headers = cookieHeaders(ada.token, HOST);
    const results = await Promise.all([1, 2].map(() => apiPost(HOST, "situation.resolve", { id, outcome: "Fixed form." }, headers)));
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const first = await savedSituation(id);
    expect((await apiPost(HOST, "situation.resolve", { id, outcome: "Fixed form." }, headers)).status).toBe(200);
    expect(await savedSituation(id)).toEqual(first);
  });

  it.each([
    { label: "empty", outcome: "" }, { label: "whitespace", outcome: " \t\n " }, { label: "oversized", outcome: "x".repeat(4001) },
  ])("rejects $label outcome input before writing", async ({ outcome }) => {
    const tenant = await seedTenant("acme");
    const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
    const id = await seedSituation(tenant, ada.identity);
    const before = await savedSituation(id);
    expect((await apiPost(HOST, "situation.resolve", { id, outcome }, cookieHeaders(ada.token, HOST))).status).toBe(400);
    expect(await savedSituation(id)).toEqual(before);
  });

  it("refuses readers and outsiders, and conceals other tenants' situations even from members", async () => {
    const tenant = await seedTenant("acme");
    const otherTenant = await seedTenant("other");
    const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
    const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: tenant.id, role: "reader" }] });
    const outsider = await seedHuman("outsider@example.com");
    const id = await seedSituation(tenant, ada.identity);
    const foreign = await seedSituation(otherTenant, outsider.identity);
    const before = await savedSituation(id);
    const foreignBefore = await savedSituation(foreign);
    for (const [actor, status] of [[reader, 403], [outsider, 404]] as const) {
      expect((await apiPost(HOST, "situation.resolve", { id, outcome: "Changed." }, cookieHeaders(actor.token, HOST))).status).toBe(status);
    }
    expect((await apiPost(HOST, "situation.resolve", { id, outcome: "Changed." })).status).toBe(404);
    for (const unknown of [foreign, "missing"]) {
      const response = await apiPost(HOST, "situation.resolve", { id: unknown, outcome: "Changed." }, cookieHeaders(ada.token, HOST));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("Why did signups fall?");
    }
    expect(await savedSituation(id)).toEqual(before);
    expect(await savedSituation(foreign)).toEqual(foreignBefore);
    const page = await SELF.fetch(`https://${HOST}/situations?s=${foreign}`, { headers: cookieHeaders(ada.token, HOST) });
    expect(await page.text()).not.toContain("Original diagnosis");
    const listing = await apiPost(HOST, "situation.list", {}, cookieHeaders(ada.token, HOST));
    expect((await listing.text())).not.toContain(foreign);
  });

  it.each([
    { outcome: "Legacy finding", outcome_by: null, outcome_at: null },
    { outcome: "", outcome_by: null, outcome_at: null },
    { outcome: null, outcome_by: "self", outcome_at: null },
    { outcome: null, outcome_by: null, outcome_at: 123 },
  ])("preserves legacy outcome evidence and partial attribution rather than silently repairing it: %j", async (legacy) => {
    const tenant = await seedTenant("acme");
    const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
    const id = await seedSituation(tenant, ada.identity);
    await env.HUB_DB.prepare("UPDATE situation SET outcome = ?, outcome_by = ?, outcome_at = ? WHERE id = ?")
      .bind(legacy.outcome, legacy.outcome_by === "self" ? ada.identity.id : null, legacy.outcome_at, id).run();
    const before = await savedSituation(id);
    expect((await apiPost(HOST, "situation.resolve", { id, outcome: "New finding" }, cookieHeaders(ada.token, HOST))).status).toBe(409);
    expect(await savedSituation(id)).toEqual(before);
    const page = await (await SELF.fetch(`https://${HOST}/situations?s=${id}`, { headers: cookieHeaders(ada.token, HOST) })).text();
    if (legacy.outcome !== null) {
      expect(page).toContain("an unknown recorder");
      expect(page).toContain("time unknown");
    } else {
      expect(page).toContain("Outcome record is incomplete");
    }
    expect(page).not.toContain('action="/api/situation.resolve"');
  });

  it("renders attribution and outcomes inertly beside the unchanged original diagnosis", async () => {
    const tenant = await seedTenant("acme");
    const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
    const id = await seedSituation(tenant, ada.identity);
    await env.HUB_DB.prepare("UPDATE identity SET display_name = ? WHERE id = ?").bind('<img src=x onerror="alert(1)">', ada.identity.id).run();
    const headers = cookieHeaders(ada.token, HOST);
    const outcome = '<script>alert("outcome")</script>';
    expect((await apiPost(HOST, "situation.resolve", { id, outcome }, headers)).status).toBe(200);
    const page = await (await SELF.fetch(`https://${HOST}/situations?s=${id}`, { headers })).text();
    expect(page).toContain("Original diagnosis");
    expect(page).toContain("Confidence: low");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("&lt;img");
    expect(page).not.toContain(outcome);
    expect(page).not.toContain('<img src=x onerror="alert(1)">');
    expect(page).toContain("UTC");
  });
});
