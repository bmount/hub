// Auth stress suite (overnight plan 2, N2): the attacks and lifecycle changes an assistant connection must survive,
// run against the real OAuth and /mcp endpoints. Complements mcp-endpoint, mcp-dance and oauth-token tests.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/db/projects";
import { setTenantState } from "../src/db/tenants";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { authorize, connectWithTokens, mcpPost, pkce, registerClient, resourceFor, rpcBody } from "./oauth-helpers";

async function world(scope?: string) {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  await createProject(env.HUB_DB, { tenant_id: acme.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  await createProject(env.HUB_DB, { tenant_id: blue.id, namespace_id: null, slug: "secret", kind: "repo", display_name: "Secret" }, Date.now());
  const ann = await seedHuman("ann@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }, { tenant_id: blue.id, role: "member" }] });
  const root = await seedHuman("root@example.com", { is_root: true });
  const blueItem = (await (await apiPost("blue.pimwell.test", "work.create", { project: "secret", kind: "snag", title: "Blue only" }, cookieHeaders(ann.token, "blue.pimwell.test"))).json()) as { result: { item: { id: string } } };
  const c = await connectWithTokens(ann.token, scope ? { scope } : {});
  return { acme, blue, ann, root, access: c.tokens.access_token, tokens: c.tokens, blueItemId: blueItem.result.item.id };
}
const tool = async (access: string, name: string, args: Record<string, unknown> = {}, slug = "acme") => {
  const res = await mcpPost(slug, access, "tools/call", { name, arguments: args });
  return { status: res.status, body: res.status === 200 ? await rpcBody(res) : null };
};

describe("auth stress", () => {
  it("refuses scopes that do not exist at authorization", async () => {
    const acme = await seedTenant("acme");
    await seedHuman("ann@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const client_id = await registerClient();
    const { challenge } = await pkce();
    for (const scope of ["read admin", "hub", "read write secrets"]) {
      const res = await authorize({ client_id, challenge, resource: resourceFor("acme"), scope });
      expect(res.headers.get("location") ?? "", scope).toContain("error=invalid_scope");
    }
  });

  it("a read grant can never write, whatever it asks", async () => {
    const w = await world();
    expect(w.tokens.scope).toBe("read");
    const r = await tool(w.access, "work_create", { project: "site", kind: "bug", title: "x" });
    expect(r.body.result.isError).toBe(true);
    const list = await rpcBody(await mcpPost("acme", w.access, "tools/list"));
    expect(list.result.tools.map((t: { name: string }) => t.name)).not.toContain("work_create");
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM work_item WHERE project_id IN (SELECT id FROM project WHERE slug = 'site')").first()).toEqual({ n: 0 });
  });

  it("a read-and-write grant writes only in its own organization", async () => {
    const w = await world("read write");
    expect(w.tokens.scope).toBe("read write");
    expect((await tool(w.access, "work_create", { project: "site", kind: "bug", title: "ok" })).body.result.isError).toBeUndefined();
    // Another organization's project, named from acme's endpoint: not found, nothing written.
    expect((await tool(w.access, "work_create", { project: "secret", kind: "bug", title: "x" })).body.result.isError).toBe(true);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM work_item WHERE tenant_id = ?").bind(w.blue.id).first()).toEqual({ n: 1 });
  });

  it("raw ids from another organization are not found through this one", async () => {
    const w = await world();
    for (const [name, args] of [["work_read", { id: w.blueItemId }], ["work_read", { id: "secret#1" }], ["mail_read", { id: w.blueItemId }]] as const) {
      const r = await tool(w.access, name, args);
      expect(r.body.result.isError, name).toBe(true);
      expect(JSON.stringify(r.body), name).not.toContain("Blue only");
    }
  });

  it("archiving the organization ends the connection", async () => {
    const w = await world();
    await apiPost("pimwell.test", "tenant.archive", { slug: "acme" }, cookieHeaders(w.root.token, "pimwell.test"));
    const r = await mcpPost("acme", w.access, "tools/list");
    expect(r.status).toBe(401);
  });

  it("deleting the organization ends the connection and leaves nothing to reuse", async () => {
    const w = await world();
    await setTenantState(env.HUB_DB, w.acme.id, "archived", Date.now());
    const del = await apiPost("pimwell.test", "tenant.delete", { slug: "acme", confirm: "acme" }, cookieHeaders(w.root.token, "pimwell.test"));
    expect(del.status).toBe(200);
    expect((await mcpPost("acme", w.access, "tools/list")).status).toBe(401);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM oauth_grant WHERE tenant_id = ?").bind(w.acme.id).first()).toEqual({ n: 0 });
  });

  it("an expired grant is refused", async () => {
    const w = await world();
    await env.HUB_DB.prepare("UPDATE oauth_grant SET expires_at = ?").bind(Date.now() - 1000).run();
    expect((await mcpPost("acme", w.access, "tools/list")).status).toBe(401);
  });

  it("a membership removed mid-session takes every tool away at once", async () => {
    const w = await world("read write");
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ? AND tenant_id = ?").bind(w.ann.identity.id, w.acme.id).run();
    const r = await mcpPost("acme", w.access, "tools/call", { name: "work_list", arguments: {} });
    expect(r.status === 401 || (await rpcBody(r)).result?.isError === true).toBe(true);
  });

  it("limits calls per connection", async () => {
    const w = await world();
    let limited = 0;
    // The bucket counts per calendar minute (120). Twice the limit plus one guarantees a full count even when the
    // loop straddles a minute boundary, which made 125 calls flaky.
    for (let i = 0; i < 241 && limited === 0; i++) {
      const r = await mcpPost("acme", w.access, "tools/list");
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  }, 30_000);

  it("no tool result ever contains a credential", async () => {
    const w = await world();
    const secrets = [w.ann.token, w.root.token, w.access, w.tokens.refresh_token];
    const tools = (await rpcBody(await mcpPost("acme", w.access, "tools/list"))).result.tools.map((t: { name: string }) => t.name) as string[];
    const args: Record<string, Record<string, unknown>> = { project_history: { project: "site" }, skill_read: { name: "start-here" }, work_read: { id: "site#1" }, mail_read: { id: "x" }, chat_read: { c: "general" }, chat_thread: { c: "general", seq: 1 }, ref_backlinks: { ref: "site#1" } };
    for (const name of tools) {
      const res = await mcpPost("acme", w.access, "tools/call", { name, arguments: args[name] ?? {} });
      const text = await res.text();
      for (const s of secrets) expect(text.includes(s), `${name} leaked a credential`).toBe(false);
      expect(text, name).not.toMatch(/pm[sw]_[A-Za-z0-9_-]{30,}/);
    }
  });
});
