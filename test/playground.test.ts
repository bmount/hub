import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { setTenantState } from "../src/db/tenants";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const ACME = "acme.pimwell.test";
async function world() {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  await createProject(env.HUB_DB, { tenant_id: acme.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  await createProject(env.HUB_DB, { tenant_id: blue.id, namespace_id: null, slug: "secret", kind: "repo", display_name: "Secret" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
  const rae = await seedHuman("rae@example.com", { memberships: [{ tenant_id: acme.id, role: "reader" }] });
  const bo = await seedHuman("bo@example.com", { memberships: [{ tenant_id: blue.id, role: "admin" }] });
  await apiPost(`blue.pimwell.test`, "work.create", { project: "secret", kind: "snag", title: "Blue's private snag" }, cookieHeaders(bo.token, "blue.pimwell.test"));
  return { acme, blue, pat, rae, bo };
}
function play(token: string, body: unknown, opts: { host?: string; origin?: string | null; header?: string | null; type?: string; auth?: Record<string, string> } = {}) {
  const host = opts.host ?? ACME;
  const headers: Record<string, string> = { "content-type": opts.type ?? "application/json", ...(opts.auth ?? { cookie: `pmw_session=${token}` }) };
  if (opts.origin !== null) headers.origin = opts.origin ?? `https://${host}`;
  if (opts.header !== null) headers["x-pimwell-playground"] = opts.header ?? "1";
  return SELF.fetch(`https://${host}/playground/call`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}
type Out = { response: { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> } }; ms: number };
const result = async (r: Response) => { expect(r.status, await r.clone().text()).toBe(200); return ((await r.json()) as Out).response.result; };

describe("the in-context Playground", () => {
  it("runs a tool exactly as an assistant would, and records it as a Playground call on this session", async () => {
    const w = await world();
    const r = await result(await play(w.pat.token, { tool: "project_list", arguments: {}, scopes: "read" }));
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent!.projects as Array<{ path: string }>).map((p) => p.path)).toEqual(["site"]);
    const ev = await env.HUB_DB.prepare("SELECT kind, session_id, tenant_id FROM event WHERE kind = 'playground.call'").first();
    expect(ev).toEqual({ kind: "playground.call", session_id: w.pat.session.id, tenant_id: w.acme.id });
  });

  it("stays inside the host's organization: nothing in a call can reach another one", async () => {
    const w = await world();
    const list = await result(await play(w.pat.token, { tool: "work_list", arguments: {}, scopes: "read" }));
    expect(JSON.stringify(list)).not.toContain("Blue's private snag");
    const read = await result(await play(w.pat.token, { tool: "work_read", arguments: { id: "secret#1" }, scopes: "read" }));
    expect(read.isError).toBe(true);
    expect(JSON.stringify(read)).not.toContain("Blue's private snag");
    // A member of acme cannot use blue's Playground at all.
    expect((await play(w.pat.token, { tool: "work_list", arguments: {}, scopes: "read" }, { host: "blue.pimwell.test" })).status).toBe(404);
  });

  it("only narrows authority: write tools need the write scope, and the role still decides", async () => {
    const w = await world();
    const denied = await result(await play(w.pat.token, { tool: "work_create", arguments: { project: "site", kind: "bug", title: "x" }, scopes: "read" }));
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain("not_found");
    const ok = await result(await play(w.pat.token, { tool: "work_create", arguments: { project: "site", kind: "bug", title: "From the Playground" }, scopes: "write" }));
    expect(ok.isError).toBeUndefined();
    const reader = await result(await play(w.rae.token, { tool: "work_create", arguments: { project: "site", kind: "bug", title: "x" }, scopes: "write" }));
    expect(reader.isError).toBe(true);
    const caps = await result(await play(w.pat.token, { tool: "capabilities", arguments: {}, scopes: "read" }));
    expect(caps.structuredContent!.scopes).toEqual(["read"]);
  });

  it("offers only MCP tools: verbs never exposed to assistants stay unreachable", async () => {
    const w = await world();
    for (const tool of ["invite_create", "token_create", "tenant_delete", "mail_release", "session_git"]) {
      const r = await result(await play(w.pat.token, { tool, arguments: {}, scopes: "write" }));
      expect(r.isError, tool).toBe(true);
    }
  });

  it("refuses cross-site and non-browser use", async () => {
    const w = await world();
    const ok = { tool: "whoami", arguments: {}, scopes: "read" };
    expect((await play(w.pat.token, ok, { origin: "https://evil.example" })).status).toBe(403);
    expect((await play(w.pat.token, ok, { origin: "https://blue.pimwell.test" })).status).toBe(403);
    expect((await play(w.pat.token, ok, { origin: null })).status).toBe(403);
    expect((await play(w.pat.token, ok, { header: null })).status).toBe(403);
    expect((await play(w.pat.token, JSON.stringify(ok), { type: "text/plain" })).status).toBe(403);
    expect((await play(w.pat.token, ok, { auth: bearer(w.pat.token) })).status).toBe(403);
    const agent = await seedAgent(w.acme, w.pat.identity, "scout");
    expect((await play(agent.token, ok, { auth: bearer(agent.token) })).status).toBe(403);
    expect((await play("pms_nope", ok)).status).toBe(404);
  });

  it("refuses archived organizations, removed members and bad requests", async () => {
    const w = await world();
    const ok = { tool: "whoami", arguments: {}, scopes: "read" };
    expect((await play(w.pat.token, { ...ok, scopes: "admin" })).status).toBe(400);
    expect((await play(w.pat.token, { ...ok, arguments: [1] })).status).toBe(400);
    expect((await play(w.pat.token, "{not json")).status).toBe(400);
    expect((await play(w.pat.token, { tool: "x".repeat(65), arguments: {}, scopes: "read" })).status).toBe(400);
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ?").bind(w.rae.identity.id).run();
    expect((await play(w.rae.token, ok)).status).toBe(404);
    await setTenantState(env.HUB_DB, w.acme.id, "archived", Date.now());
    expect((await play(w.pat.token, ok)).status).toBe(404);
  });

  it("never returns a credential", async () => {
    const w = await world();
    const r = await play(w.pat.token, { tool: "whoami", arguments: {}, scopes: "write" });
    const text = await r.text();
    expect(text).not.toContain(w.pat.token);
    expect(text).not.toMatch(/pm[sw]_[A-Za-z0-9_-]{20,}/);
  });

  it("shows the page to members with the tools for the chosen scopes, and to no one else", async () => {
    const w = await world();
    const page = await (await SELF.fetch(`https://${ACME}/assistant/tools`, { headers: cookieHeaders(w.pat.token, ACME) })).text();
    expect(page).toContain("<h1>Tools</h1>");
    expect(page).toContain('data-tool="work_list"');
    expect(page).not.toContain('data-tool="work_create"');
    const write = await (await SELF.fetch(`https://${ACME}/assistant/tools?scopes=write`, { headers: cookieHeaders(w.pat.token, ACME) })).text();
    expect(write).toContain('data-tool="work_create"');
    expect((await SELF.fetch(`https://blue.pimwell.test/assistant/tools`, { headers: cookieHeaders(w.pat.token, "blue.pimwell.test") })).status).toBe(404);
    expect((await SELF.fetch(`https://pimwell.test/assistant/tools`, { headers: cookieHeaders(w.pat.token, "pimwell.test") })).status).toBe(404);
  });
});
