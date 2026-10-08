import { live } from "./live-tools";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, seedHuman, seedTenant } from "./helpers";
import { INIT, connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";

async function connected(role: "member" | "reader" = "member") {
  const acme = await seedTenant("acme");
  const blue = await seedTenant("blue");
  const h = await seedHuman("ann@example.com", { memberships: [{ tenant_id: acme.id, role }, { tenant_id: blue.id, role: "member" }] });
  const c = await connectWithTokens(h.token);
  const grant = await env.HUB_DB.prepare("SELECT * FROM oauth_grant").first<Record<string, any>>();
  return { acme, blue, h, access: c.tokens.access_token, grant: grant! };
}

const toolNames = async (token: string) => (await rpcBody(await mcpPost("acme", token, "tools/list"))).result.tools.map((t: { name: string }) => t.name);

describe("/mcp with a token", () => {
  it("initializes, lists tools for the role, and calls one as the grant's session", async () => {
    const { acme, h, access, grant } = await connected();
    const init = await rpcBody(await mcpPost("acme", access, "initialize", INIT));
    expect(init.result.serverInfo.name).toBe("pimwell");
    expect(init.result.capabilities.tools).toBeDefined();
    expect(live(await toolNames(access))).toEqual(["app_list", "attention_list", "capabilities", "chat_catchup", "chat_inbox", "chat_read", "chat_thread", "deploy_list", "event_list", "mail_list", "mail_propose_work", "mail_read", "message_search", "project_history", "project_list", "ref_backlinks", "search_query", "skill_list", "skill_read", "trace_list", "trace_read", "usage_summary", "whoami", "work_list", "work_read", "work_search"]);
    await apiPost("acme.pimwell.test", "project.create", { slug: "site", kind: "repo", display_name: "Site" }, bearer(h.token));
    const call = await rpcBody(await mcpPost("acme", access, "tools/call", { name: "project_list", arguments: {} }));
    expect(call.result.isError).toBeUndefined();
    expect(call.result.structuredContent.projects.map((p: { path: string }) => p.path)).toEqual(["site"]);
    expect(call.result.content[0].text).toContain("| `site` |");
    const who = await rpcBody(await mcpPost("acme", access, "tools/call", { name: "whoami", arguments: {} }));
    expect(who.result.structuredContent).toMatchObject({ session: { id: grant.session_id, kind: "oauth" }, tenant: { slug: "acme", role: "member" }, connection: { client: "Claude Code", scopes: ["read"] } });
    expect(who.result.structuredContent.memberships).toEqual([{ slug: "acme", display_name: "ACME", role: "member" }]);
    const ev = await env.HUB_DB.prepare("SELECT * FROM event WHERE kind = 'mcp.call' ORDER BY id").all<Record<string, unknown>>();
    // Compared sorted: two events in one millisecond have ULIDs in random order.
    expect(ev.results.map((e) => [e.target_id, e.session_id, e.tenant_id]).sort()).toEqual([
      ["project.list", grant.session_id, acme.id], ["whoami", grant.session_id, acme.id],
    ]);
    const own = await rpcBody(await mcpPost("acme", access, "tools/call", { name: "event_list", arguments: { session_id: grant.session_id } }));
    expect(own.result.structuredContent.events.map((e: { kind: string }) => e.kind)).toEqual(["mcp.call", "mcp.call"]);
  });

  it("drops tools when the role drops, without re-consent", async () => {
    const { acme, h, access } = await connected();
    await env.HUB_DB.prepare("UPDATE membership SET role = 'reader' WHERE identity_id = ? AND tenant_id = ?").bind(h.identity.id, acme.id).run();
    expect(live(await toolNames(access))).toEqual(["app_list", "attention_list", "capabilities", "chat_catchup", "chat_inbox", "chat_read", "chat_thread", "deploy_list", "mail_list", "mail_read", "message_search", "project_history", "project_list", "ref_backlinks", "search_query", "skill_list", "skill_read", "trace_list", "trace_read", "usage_summary", "whoami", "work_list", "work_read", "work_search"]);
    const denied = await rpcBody(await mcpPost("acme", access, "tools/call", { name: "event_list", arguments: {} }));
    expect(denied.result.isError).toBe(true);
    expect(await env.HUB_DB.prepare("SELECT 1 FROM event WHERE kind = 'mcp.denied'").first()).not.toBeNull();
  });

  it("rejects the token on another tenant, after revocation, and after offboarding", async () => {
    const { acme, h, access, grant } = await connected();
    const blue = await mcpPost("blue", access, "tools/list");
    expect(blue.status).toBe(401);
    expect(blue.headers.get("www-authenticate")).toBe('Bearer error="invalid_token", resource_metadata="https://blue.pimwell.test/.well-known/oauth-protected-resource/mcp", scope="read write"');
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ? AND tenant_id = ?").bind(h.identity.id, acme.id).run();
    expect((await mcpPost("acme", access, "tools/list")).status).toBe(401);
    await env.HUB_DB.prepare("UPDATE membership SET state = 'active' WHERE identity_id = ? AND tenant_id = ?").bind(h.identity.id, acme.id).run();
    expect((await mcpPost("acme", access, "tools/list")).status).toBe(200);
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = 1 WHERE id = ?").bind(grant.id).run();
    expect((await mcpPost("acme", access, "tools/list")).status).toBe(401);
    expect((await mcpPost("acme", "not-a-token", "tools/list")).status).toBe(401);
  });

  it("is never accepted on /api or pages, and /mcp ignores cookies", async () => {
    const { h, access } = await connected();
    const who = (await (await apiPost("acme.pimwell.test", "whoami", {}, bearer(access))).json()) as any;
    expect(who.result.identity).toBeNull();
    expect((await apiPost("acme.pimwell.test", "project.list", {}, bearer(access))).status).toBe(404);
    expect((await SELF.fetch("https://pimwell.test/me", { headers: bearer(access) })).status).toBe(401);
    const cookieOnly = await mcpPost("acme", null, "tools/list", {}, { cookie: `pmw_session=${h.token}` });
    expect(cookieOnly.status).toBe(401);
  });

  it("checks Origin and answers GET with 405", async () => {
    const { access } = await connected();
    expect((await mcpPost("acme", access, "tools/list", {}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await mcpPost("acme", access, "tools/list", {}, { origin: "https://claude.ai" })).status).toBe(200);
    expect((await SELF.fetch("https://acme.pimwell.test/mcp", { headers: bearer(access) })).status).toBe(405);
  });
});
