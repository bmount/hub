import { live } from "./live-tools";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiPost, bearer, seedAgent, seedHuman, seedTenant } from "./helpers";
import { createNamespace } from "../src/db/namespaces";
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

async function projectRpc(project: string, token: string | null, method: string, params: unknown = {}, host = "acme", extra: Record<string, string> = {}) {
  return SELF.fetch(`https://${host}.pimwell.test/p/${project}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? bearer(token) : {}), ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("project MCP", () => {
  it("scopes OAuth discovery, implicit calls, ID references, mail and kind changes", async () => {
    const { acme, h, access } = await connected();
    for (const [slug, kind] of [["desk", "workspace"], ["other", "workspace"], ["pages", "wiki"], ["code", "repo"]]) {
      await apiPost("acme.pimwell.test", "project.create", { slug, kind, display_name: slug }, bearer(h.token));
    }
    const init = await rpcBody(await projectRpc("desk", access, "initialize", INIT));
    expect(init.result.serverInfo).toMatchObject({ name: "pimwell-acme-desk", title: "Pimwell · ACME / desk" });
    const list = (await rpcBody(await projectRpc("desk", access, "tools/list"))).result.tools;
    expect(list.map((t: any) => t.name)).toEqual(expect.arrayContaining(["wiki_list", "research_list", "file_list", "person_list", "company_list", "connection_list", "graph_path", "work_list", "mail_list"]));
    expect(list.some((t: any) => /^(repo|project|chat|search|usage|app|deploy|trace)_/.test(t.name))).toBe(false);
    for (const t of list) {
      expect(t.inputSchema.properties.project).toBeUndefined();
      expect(t.inputSchema.required ?? []).not.toContain("project");
    }
    const own = await rpcBody(await projectRpc("desk", access, "tools/call", { name: "wiki_list", arguments: {} }));
    expect(own.result.structuredContent.pages).toEqual([]);
    const override = await rpcBody(await projectRpc("desk", access, "tools/call", { name: "wiki_list", arguments: { project: "other" } }));
    expect(override.result.isError).toBe(true);
    const created = await (await apiPost("acme.pimwell.test", "work.create", { project: "other", kind: "errand", title: "Private to other endpoint" }, bearer(h.token))).json() as any;
    for (const id of ["other#1", created.result.item.id]) {
      const denied = await rpcBody(await projectRpc("desk", access, "tools/call", { name: "work_read", arguments: { id } }));
      expect(denied.result.isError).toBe(true);
      expect(JSON.stringify(denied)).not.toContain("Private to other endpoint");
    }
    const pages = (await rpcBody(await projectRpc("pages", access, "tools/list"))).result.tools.map((t: any) => t.name);
    expect(pages.sort()).toEqual(["file_get", "file_history", "file_list", "wiki_history", "wiki_list", "wiki_read"]);
    const repos = (await rpcBody(await projectRpc("code", access, "tools/list"))).result.tools.map((t: any) => t.name);
    expect(repos).toContain("repo_file");
    expect(repos).not.toContain("wiki_list");
    const mailId = "project-test-mail";
    await env.HUB_DB.prepare(`INSERT INTO inbound_mail (id, tenant_id, project_id, identity_id, from_email, to_address, subject, received_at, size, verdict, text, attachments, forwarded) SELECT ?, ?, id, ?, 'sender@example.com', 'acme.other@pimwell.test', 'other secret', ?, 1, 'admitted', 'secret body', '[]', 0 FROM project WHERE tenant_id = ? AND slug = 'other'`).bind(mailId, acme.id, h.identity.id, Date.now(), acme.id).run();
    const mail = await rpcBody(await projectRpc("desk", access, "tools/call", { name: "mail_read", arguments: { id: mailId } }));
    expect(mail.result.isError).toBe(true);
    const mails = await rpcBody(await projectRpc("desk", access, "tools/call", { name: "mail_list", arguments: {} }));
    expect(mails.result.structuredContent.mail).toEqual([]);
    expect((await projectRpc("missing", access, "tools/list")).status).toBe(404);
    expect((await projectRpc("desk", access, "tools/list", {}, "blue")).status).toBe(401);
    expect((await projectRpc("desk", null, "tools/list", {}, "acme", { cookie: `pmw_session=${h.token}` })).status).toBe(401);
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE tenant_id = ? AND slug = 'desk'").bind(acme.id).run();
    expect((await projectRpc("desk", access, "tools/list")).status).toBe(404);
  });

  it("pins same-slug namespaced projects by ID rather than falling back to a root project", async () => {
    const acme = await seedTenant("acme");
    const h = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const a = await seedAgent(acme, h.identity);
    await createNamespace(env.HUB_DB, { tenant_id: acme.id, slug: "group", display_name: "Group" }, Date.now());
    for (const namespace of [undefined, "group"]) {
      await apiPost("acme.pimwell.test", "project.create", { slug: "desk", kind: "workspace", display_name: namespace ?? "Root", namespace }, bearer(h.token));
    }
    const write = (path: string, body: string) => projectRpc(path, a.longLived, "tools/call", { name: "wiki_write", arguments: { slug: "hello", title: "Hello", body, expected_revision: 0, note: "test" } });
    expect((await rpcBody(await write("desk", "root only"))).result.isError).toBeUndefined();
    expect((await rpcBody(await write("group/desk", "group only"))).result.isError).toBeUndefined();
    const read = await rpcBody(await projectRpc("group/desk", a.longLived, "tools/call", { name: "wiki_read", arguments: { slug: "hello" } }));
    expect(read.result.structuredContent.page.body).toBe("group only");
    expect(JSON.stringify(read)).not.toContain("root only");
    expect((await projectRpc("wrong/desk", a.longLived, "tools/list")).status).toBe(404);
  });

  it("accepts agent tokens, caps writes by current role and refuses cross-project writes", async () => {
    const acme = await seedTenant("acme");
    const op = await seedHuman("op@example.com", { memberships: [{ tenant_id: acme.id, role: "member" }] });
    const seeded = await seedAgent(acme, op.identity);
    const agent = { token: seeded.longLived };
    for (const slug of ["desk", "other"]) await apiPost("acme.pimwell.test", "project.create", { slug, kind: "workspace", display_name: slug }, bearer(op.token));
    const tools = (await rpcBody(await projectRpc("desk", agent.token, "tools/list"))).result.tools.map((t: any) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["doc_share", "doc_dispatch"]));
    const crossDocument = await rpcBody(await projectRpc("desk", agent.token, "tools/call", {name: "doc_share", arguments: {project: "other", slug: "hello", recipients: ["op@example.com"], note: "No"}}));
    expect(crossDocument.result.isError).toBe(true);
    expect(await env.HUB_DB.prepare("SELECT 1 FROM document_delivery").first()).toBeNull();
    const init = await rpcBody(await projectRpc("desk", agent.token, "initialize", INIT));
    expect(init.result.serverInfo.name).toBe("pimwell-acme-desk");
    const write = await rpcBody(await projectRpc("desk", agent.token, "tools/call", { name: "wiki_write", arguments: { slug: "hello", title: "Hello", body: "Own project", expected_revision: 0, note: "test" } }));
    expect(write.result.isError).toBeUndefined();
    const bad = await rpcBody(await projectRpc("desk", agent.token, "tools/call", { name: "wiki_write", arguments: { project: "other", slug: "hello", title: "Hello", body: "Wrong project", expected_revision: 0, note: "test" } }));
    expect(bad.result.isError).toBe(true);
    expect(await env.HUB_DB.prepare("SELECT 1 FROM wiki_revision r JOIN project p ON p.id = r.project_id WHERE p.slug = 'other'").first()).toBeNull();
    const create = async (project: string) => (await (await apiPost("acme.pimwell.test", "work.create", { project, kind: "errand", title: `Item in ${project}` }, bearer(op.token))).json() as any).result.item;
    const ownItem = await create("desk"), otherItem = await create("other");
    const deniedWrite = await rpcBody(await projectRpc("desk", agent.token, "tools/call", { name: "work_update", arguments: { id: otherItem.id, state: "done" } }));
    expect(deniedWrite.result.isError).toBe(true);
    expect((await env.HUB_DB.prepare("SELECT state FROM work_item WHERE id = ?").bind(otherItem.id).first<any>()).state).toBe("open");
    const deniedEdge = await rpcBody(await projectRpc("desk", agent.token, "tools/call", { name: "work_depend", arguments: { id: ownItem.id, on: [otherItem.id] } }));
    expect(deniedEdge.result.isError).toBe(true);
    expect(await env.HUB_DB.prepare("SELECT 1 FROM work_dep").first()).toBeNull();
    const proposed = await rpcBody(await projectRpc("desk", agent.token, "tools/call", { name: "work_propose", arguments: { reason: "Own work", new_items: [{ key: "one", kind: "errand", title: "Scoped new item" }] } }));
    expect(proposed.result.isError).toBeUndefined();
    const wrongProposal = await rpcBody(await projectRpc("desk", agent.token, "tools/call", { name: "work_propose", arguments: { reason: "Wrong work", new_items: [{ key: "one", project: "other", kind: "errand", title: "Do not file" }] } }));
    expect(wrongProposal.result.isError).toBe(true);
    const otherProposals = await rpcBody(await projectRpc("other", agent.token, "tools/call", { name: "work_proposals", arguments: {} }));
    expect(otherProposals.result.structuredContent.proposals).toEqual([]);
    const review = await rpcBody(await projectRpc("other", agent.token, "tools/call", { name: "work_review", arguments: { id: proposed.result.structuredContent.id, decision: "approve" } }));
    expect(review.result.isError).toBe(true);
    await apiPost("acme.pimwell.test", "work.depend", { id: ownItem.id, on: [otherItem.id] }, bearer(op.token));
    const graph = await rpcBody(await projectRpc("desk", agent.token, "tools/call", { name: "work_graph", arguments: {} }));
    expect(graph.result.isError).toBe(true);
    expect(JSON.stringify(graph)).not.toContain("Item in other");
    const page = await (await SELF.fetch("https://acme.pimwell.test/desk", { headers: { cookie: `pmw_session=${op.token}` } })).text();
    expect(page).toContain("https://acme.pimwell.test/p/desk/mcp");
    expect(page).toContain('data-copy="#project-mcp-url"');
    expect((await projectRpc("desk", agent.token, "tools/list", {}, "acme", { origin: "https://claude.ai" })).status).toBe(403);
    await env.HUB_DB.prepare("UPDATE membership SET role = 'reader' WHERE identity_id = ? AND tenant_id = ?").bind(op.identity.id, acme.id).run();
    const names = (await rpcBody(await projectRpc("desk", agent.token, "tools/list"))).result.tools.map((t: any) => t.name);
    expect(names).not.toContain("wiki_write");
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ? AND tenant_id = ?").bind(op.identity.id, acme.id).run();
    expect((await projectRpc("desk", agent.token, "tools/list")).status).toBe(401);
  });
});

describe("/mcp with a token", () => {
  it("initializes, lists tools for the role, and calls one as the grant's session", async () => {
    const { acme, h, access, grant } = await connected();
    const init = await rpcBody(await mcpPost("acme", access, "initialize", INIT));
    expect(init.result.serverInfo).toMatchObject({ name: "pimwell-acme", title: "Pimwell · ACME" });
    expect(init.result.instructions.split("\n")[0]).toBe(init.result.serverInfo.title);
    expect(init.result.capabilities.tools).toBeDefined();
    expect(live(await toolNames(access))).toEqual(["app_list", "attention_list", "capabilities", "chat_catchup", "chat_history", "chat_inbox", "chat_post_status", "chat_presence", "chat_read", "chat_read_status", "chat_response_status", "chat_run_status", "chat_thread", "company_list", "company_read", "connection_list", "deploy_list", "deploy_read", "event_list", "file_get", "file_history", "file_list", "graph_neighbors", "graph_path", "inbox_ack_status", "mail_list", "mail_propose_work", "mail_read", "message_search", "person_list", "person_read", "project_history", "project_list", "project_status", "ref_backlinks", "repo_branches", "repo_commit", "repo_connect", "repo_diff", "repo_file", "repo_list", "repo_log", "repo_search", "research_list", "review_list", "review_read", "search_query", "situation_list", "skill_list", "skill_read", "trace_list", "trace_read", "usage_summary", "whoami", "wiki_history", "wiki_list", "wiki_read", "work_board", "work_frontier", "work_graph", "work_list", "work_proposals", "work_read", "work_search"]);
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
    expect(live(await toolNames(access))).toEqual(["app_list", "attention_list", "capabilities", "chat_catchup", "chat_history", "chat_inbox", "chat_post_status", "chat_presence", "chat_read", "chat_read_status", "chat_response_status", "chat_run_status", "chat_thread", "company_list", "company_read", "connection_list", "deploy_list", "deploy_read", "file_get", "file_history", "file_list", "graph_neighbors", "graph_path", "inbox_ack_status", "mail_list", "mail_read", "message_search", "person_list", "person_read", "project_history", "project_list", "project_status", "ref_backlinks", "repo_branches", "repo_commit", "repo_connect", "repo_diff", "repo_file", "repo_list", "repo_log", "repo_search", "research_list", "review_list", "review_read", "search_query", "situation_list", "skill_list", "skill_read", "trace_list", "trace_read", "usage_summary", "whoami", "wiki_history", "wiki_list", "wiki_read", "work_board", "work_frontier", "work_graph", "work_list", "work_proposals", "work_read", "work_search"]);
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
