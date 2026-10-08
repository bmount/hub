// Situations in, the truth out: a read-only investigation with tools, a diagnosis in a fixed shape, and the outcome.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setModelFetchForTest } from "../src/models/providers";
import { addCredential } from "../src/models/store";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

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
    const form = await SELF.fetch(`https://${HOST}/api/situation.open`, { method: "POST", redirect: "manual", headers: { ...h, origin: `https://${HOST}`, "content-type": "application/x-www-form-urlencoded" }, body: "text=Errors%20spiked%20this%20morning&_back=%40result" });
    expect(form.status).toBe(303);
    expect(form.headers.get("location")).toMatch(/^\/situations\?s=/);
  });
});
