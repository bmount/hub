// The Assistant (migration 0015): chat that calls Pimwell's MCP tools as the person, with a scripted model.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_CALL_TIMEOUT_MS } from "../src/models/deadline";
import { setModelFetchForTest } from "../src/models/providers";
import { addCredential } from "../src/models/store";
import { format } from "../src/http/assistantPages";
import { cookieHeaders, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
const KEY = "sk-testAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaaa";
afterEach(() => { setModelFetchForTest(null); vi.restoreAllMocks(); });

/** A model that first asks for whoami, then answers with what it learned; it records what it was sent. */
function scriptedModel(seen: Array<{ input: Array<Record<string, unknown>>; tools: Array<{ name: string }> }>) {
  setModelFetchForTest(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "gpt-6.1-sol" }] });
    const b = JSON.parse(String(init!.body)) as { input: Array<Record<string, unknown>>; tools: Array<{ name: string }> };
    seen.push({ input: b.input, tools: b.tools });
    const result = b.input.find((i) => i.type === "function_call_output");
    if (!result) return Response.json({ output: [{ type: "function_call", call_id: "c1", name: "whoami", arguments: "{}" }], usage: { input_tokens: 50, output_tokens: 5 } });
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: `You are **pat**. See site#1.` }] }], usage: { input_tokens: 80, output_tokens: 9 } });
  });
}

async function world() {
  const t = await seedTenant("acme");
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const sam = await seedHuman("sam@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const seen: Array<{ input: Array<Record<string, unknown>>; tools: Array<{ name: string }> }> = [];
  scriptedModel(seen);
  await addCredential(env.HUB_DB, env.HUB_SECRETS_KEY, { provider: "openai", label: "hub", secret: KEY, tenant_id: null, created_by: null }, Date.now());
  const chat = (token: string, body: unknown, headers: Record<string, string> = {}) => SELF.fetch(`https://${HOST}/assistant/chat`, {
    method: "POST", body: JSON.stringify(body),
    headers: { ...cookieHeaders(token, HOST), origin: `https://${HOST}`, "content-type": "application/json", "x-pimwell-playground": "1", ...headers },
  });
  return { pat, sam, seen, chat };
}

describe("the Assistant", () => {
  it("answers by calling tools as the person, and keeps the conversation", async () => {
    const w = await world();
    const r = await w.chat(w.pat.token, { text: "who am I?" });
    expect(r.status, await r.clone().text()).toBe(200);
    const j = (await r.json()) as { thread: string; reply: string; steps: Array<{ tool: string; ok: boolean; summary: string }> };
    expect(j.reply).toContain("You are **pat**");
    expect(j.steps).toMatchObject([{ tool: "whoami", ok: true }]);
    expect(j.steps[0]!.summary).toContain("pat@example.com");
    expect(w.seen[0]!.tools.map((t) => t.name)).toContain("whoami");
    expect(w.seen[0]!.tools.map((t) => t.name)).not.toContain("work_create");
    const usage = await env.HUB_DB.prepare("SELECT COUNT(*) AS n, MIN(purpose) AS p FROM model_call").first();
    expect(usage).toEqual({ n: 2, p: "assistant" });
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'playground.call'").first<{ n: number }>())!.n).toBe(1);
    // The next turn sends the stored history, not anything the browser claims.
    await w.chat(w.pat.token, { thread: j.thread, text: "and again?" });
    expect(w.seen[2]!.input.slice(0, 2)).toEqual([{ role: "user", content: "who am I?" }, { role: "assistant", content: "You are **pat**. See site#1." }]);
    const page = await (await SELF.fetch(`https://${HOST}/assistant?t=${j.thread}`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
    expect(page).toContain('<a href="/site/w/1">site#1</a>');
    expect(page).toContain("Used 1 tool");
  });

  it("returns truthful 504 and records unknown usage without executing late model tools", async () => {
    const w = await world();
    let wall = Date.now(), calls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    setModelFetchForTest(async () => {
      calls++; wall += MODEL_CALL_TIMEOUT_MS;
      return Response.json({ output: [{ type: "function_call", call_id: "late", name: "work_create", arguments: '{"project":"site","title":"late write","kind":"wish"}' }], usage: { input_tokens: 3, output_tokens: 2 } });
    });
    const response = await w.chat(w.pat.token, { text: "file something", scopes: "write" });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: "provider_timeout", reason: expect.stringContaining("Earlier tool changes are not rolled back"), thread: expect.any(String) });
    expect(calls).toBe(1);
    expect((await env.HUB_DB.prepare("SELECT ok, input_tokens, output_tokens FROM model_call").all()).results).toEqual([{ ok: 0, input_tokens: null, output_tokens: null }]);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'playground.call'").first())!.n).toBe(0);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM assistant_message").first())!.n).toBe(0);
  });

  it("offers write tools only in a conversation switched to read and write", async () => {
    const w = await world();
    await w.chat(w.pat.token, { text: "file something", scopes: "write" });
    expect(w.seen[0]!.tools.map((t) => t.name)).toContain("work_create");
  });

  it("keeps each person's conversations to themselves and refuses other origins", async () => {
    const w = await world();
    const j = (await (await w.chat(w.pat.token, { text: "hello" })).json()) as { thread: string };
    expect((await w.chat(w.sam.token, { thread: j.thread, text: "peek" })).status).toBe(404);
    expect((await SELF.fetch(`https://${HOST}/assistant?t=${j.thread}`, { headers: cookieHeaders(w.sam.token, HOST) })).status).toBe(404);
    expect((await w.chat(w.pat.token, { text: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await w.chat(w.pat.token, { text: "x" }, { "x-pimwell-playground": "" })).status).toBe(403);
    expect((await w.chat(w.pat.token, { text: "" })).status).toBe(400);
  });

  it("moves the old Playground to the Tools tab", async () => {
    const w = await world();
    const r = await SELF.fetch(`https://${HOST}/playground`, { headers: cookieHeaders(w.pat.token, HOST), redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/assistant/tools");
    const tools = await (await SELF.fetch(`https://${HOST}/assistant/tools`, { headers: cookieHeaders(w.pat.token, HOST) })).text();
    expect(tools).toContain("<h1>Tools</h1>");
    expect(tools).toContain('>Assistant</a>');
  });

  it("formats answers safely", () => {
    expect(format('<img src=x onerror=alert(1)> **bold** `code`\n- one\n- two')).toBe('<p>&lt;img src=x onerror=alert(1)&gt; <b>bold</b> <code>code</code></p><ul><li>one</li><li>two</li></ul>');
  });
});
