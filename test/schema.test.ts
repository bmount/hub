import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const EXPECTED = [
  "agent_chat_state", "agent_connect_link", "agent_mcp_session", "api_token", "app_deploy", "app_error_group", "app_event", "app_source", "app_stat", "ardi_cred", "assistant_message", "assistant_thread", "attention", "auth_link", "channel", "chat_control", "code_event", "code_sync", "consent", "contact_connection", "contact_entity", "contact_link", "conversation_member", "deleted_tenant", "document_delivery", "event", "file_revision", "file_upload", "follow", "git_commit", "git_legacy_forward", "git_push", "git_repository", "google_account", "identity", "inbound_mail", "invite",
  "membership", "meta", "model_call", "model_price", "model_route", "msg_index", "msg_ref", "namespace", "oauth_grant", "oauth_redirect_allow", "outbound_mail", "project", "proof", "provider_credential", "rate_counter", "review", "review_comment", "review_reviewer", "session", "signin_grant", "signin_rule", "site", "site_app", "situation", "tenant", "wiki_revision", "work_comment", "work_dep", "work_graph_rev", "work_item", "work_link", "work_proposal", "work_proposal_decision", "work_resource",
];

describe("schema", () => {
  it("creates every table from the spec", async () => {
    const rows = await env.HUB_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(rows.results.map((r) => r.name)).toEqual(EXPECTED);
  });

  it("records schema version 4", async () => {
    const row = await env.HUB_DB.prepare("SELECT value FROM meta WHERE key='schema_version'").first<{ value: string }>();
    expect(row?.value).toBe("4");
  });

  it("gives memberships a handle unique per tenant by skeleton", async () => {
    await expect(env.HUB_DB.prepare("SELECT handle, handle_skeleton FROM membership LIMIT 1").all()).resolves.toBeDefined();
  });

  it("seeds the redirect allowlist with Claude and loopback only", async () => {
    const rows = await env.HUB_DB.prepare("SELECT pattern FROM oauth_redirect_allow ORDER BY pattern").all<{ pattern: string }>();
    expect(rows.results.map((r) => r.pattern)).toEqual([
      "http://127.0.0.1/callback", "http://localhost/callback", "https://claude.ai/api/mcp/auth_callback",
    ]);
  });

  it("keeps git_push recovery tombstones after tenant or project deletion", async () => {
    const fks = (await env.HUB_DB.prepare("PRAGMA foreign_key_list('git_push')").all<{ table: string; from: string }>()).results;
    expect(fks.filter(fk => ["tenant_id", "project_id"].includes(fk.from))).toEqual([]);
  });

  it("enforces unique top-level project slug per tenant", async () => {
    const now = Date.now();
    await env.HUB_DB.prepare("INSERT INTO tenant (id,slug,display_name,state,created_at) VALUES ('t1','acme','Acme','active',?)").bind(now).run();
    await env.HUB_DB.prepare("INSERT INTO project (id,tenant_id,namespace_id,slug,kind,display_name,state,created_at) VALUES ('p1','t1',NULL,'site','repo','Site','active',?)").bind(now).run();
    await expect(
      env.HUB_DB.prepare("INSERT INTO project (id,tenant_id,namespace_id,slug,kind,display_name,state,created_at) VALUES ('p2','t1',NULL,'site','repo','Site 2','active',?)").bind(now).run(),
    ).rejects.toThrow(/UNIQUE/);
  });
});
