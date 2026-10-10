import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { oauthContext } from "../src/auth/context";
import { agentMcpAuth } from "../src/mcp/agentAuth";
import { liveGrant } from "../src/db/oauthGrants";
import { callTool } from "../src/mcp/tools";
import type { SearchResult } from "../src/verbs/search";
import { apiPost, bearer, cookieHeaders, seedGrant, seedHuman, seedTenant } from "./helpers";
import { chatWorld, HOST } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";

// Stored reports, not model invocations or real membership changes.
async function situation(tid: string, owner: string, id: string, fields: { title?: string; question?: string; report?: string; outcome?: string | null; at?: number } = {}) {
  await env.HUB_DB.prepare("INSERT INTO assistant_thread (id, tenant_id, identity_id, title, scopes, created_at, updated_at) VALUES (?, ?, ?, 'private thread', 'read', 1, 1)")
    .bind(`thread-${id}`, tid, owner).run();
  await env.HUB_DB.prepare("INSERT INTO situation (id, tenant_id, identity_id, thread_id, title, question, report, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, tid, owner, `thread-${id}`, fields.title ?? "A report", fields.question ?? "", fields.report ?? "", fields.outcome ?? null, fields.at ?? 1).run();
}
async function query(token: string, q: string, extra = {}): Promise<SearchResult> {
  const response = await apiPost(HOST, "search.query", { q, ...extra }, bearer(token));
  expect(response.status).toBe(200);
  return (await response.json() as { result: SearchResult }).result;
}

describe("bounded tenant-readable situation search", () => {
  it("keeps repeated reads free of report/model/mail effects and records only audit keys, not queries or evidence", async () => {
    const w = await chatWorld();
    await situation(w.acme.id, w.lead.identity.id, "stored", { report: "private-query needle stored diagnosis", outcome: "private outcome" });
    const { grant } = await seedGrant(w.acme, w.dev);
    const ctx = await oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    const snapshot = async () => Promise.all(["situation", "assistant_thread", "assistant_message", "outbound_mail", "model_call"].map(async table =>
      (await env.HUB_DB.prepare(`SELECT * FROM ${table} WHERE tenant_id = ? ORDER BY id`).bind(w.acme.id).all()).results));
    const before = await snapshot();
    for (let n = 0; n < 5; n++) {
      const result = await callTool(ctx, "search_query", { q: "private-query needle", identity_id: "forged-private-principal" });
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as SearchResult).situations).toHaveLength(1);
    }
    expect(await snapshot()).toEqual(before);
    const audits = (await env.HUB_DB.prepare("SELECT summary FROM event WHERE tenant_id = ? AND kind = 'mcp.call' AND target_id = 'search.query'").bind(w.acme.id).all<{ summary: string }>()).results;
    expect(audits).toHaveLength(5);
    expect(audits.every(a => a.summary === "search.query ok {q, +1 other}")).toBe(true);
    expect(JSON.stringify(audits)).not.toMatch(/private-query|stored diagnosis|private outcome|forged-private-principal/);
  });

  it("fails source errors rather than publishing successful empty coverage", async () => {
    const w = await chatWorld();
    await env.HUB_DB.prepare("ALTER TABLE situation RENAME TO unavailable_situation").run();
    try {
      const response = await apiPost(HOST, "search.query", { q: "needle" }, bearer(w.dev.token));
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).not.toMatch(/coverage|no such table|SELECT|situations/);
    } finally {
      await env.HUB_DB.prepare("ALTER TABLE unavailable_situation RENAME TO situation").run();
    }
  });

  it("matches title, question, diagnosis and recorded outcome, preserving all-term literal matching and bounded snippets", async () => {
    const w = await chatWorld();
    await situation(w.acme.id, w.lead.identity.id, "title", { title: "Needle title", at: 1 });
    await situation(w.acme.id, w.lead.identity.id, "question", { question: "Needle question", at: 2 });
    await situation(w.acme.id, w.lead.identity.id, "report", { report: "Needle diagnosis", at: 3 });
    await situation(w.acme.id, w.lead.identity.id, "outcome", { question: "First needle", outcome: "Verified outcome", at: 4 });
    await situation(w.acme.id, w.lead.identity.id, "literal", { report: "100% literal_under \\ needle".repeat(100), at: 5 });
    const r = await query(w.dev.token, "NEEDLE");
    expect(r.situations.map(h => h.ref)).toEqual(["literal", "outcome", "report", "question", "title"]);
    expect(r.situations.every(h => h.kind === "Situation" && h.snippet.length <= 162)).toBe(true);
    expect(r.situations[1]!.snippet).toContain("Question: First needle");
    expect(r.situations[1]!.snippet).toContain("Recorded outcome: Verified outcome");
    expect(r.situations[2]!.snippet).toContain("Diagnosis: Needle diagnosis");
    expect((await query(w.dev.token, "needle verified")).situations.map(h => h.ref)).toEqual(["outcome"]);
    expect((await query(w.dev.token, "100% literal_under \\")).situations.map(h => h.ref)).toEqual(["literal"]);
    expect((await query(w.dev.token, "notpresent")).situations).toEqual([]);
    expect(r.coverage.sources.situations).toEqual({ returned: 5, limit: 10, total_matches: null, may_have_more: false });
    expect(r.coverage.not_searched).not.toContain("situations");
    expect(r.coverage.not_searched).toContain("assistant conversations");
  });

  it("caps after the tenant predicate, orders deterministically, and conservatively discloses exact-cap ambiguity", async () => {
    const w = await chatWorld();
    const other = await seedTenant("elsewhere");
    for (let n = 0; n < 11; n++) await situation(w.acme.id, w.lead.identity.id, `local-${n}`, { report: "needle", at: n });
    await situation(other.id, w.lead.identity.id, "foreign-newest", { report: "needle secret foreign", at: 9999 });
    const r = await query(w.dev.token, "needle");
    expect(r.situations).toHaveLength(10);
    expect(r.situations.map(h => h.ref)).toEqual(Array.from({ length: 10 }, (_, n) => `local-${10 - n}`));
    expect(r.coverage.sources.situations.may_have_more).toBe(true);
    expect(JSON.stringify(r)).not.toContain("foreign");
    await env.HUB_DB.prepare("DELETE FROM situation WHERE id = 'local-0'").run();
    expect((await query(w.dev.token, "needle")).coverage.sources.situations.may_have_more).toBe(true);
    await env.HUB_DB.prepare("DELETE FROM situation WHERE id = 'local-1'").run();
    expect((await query(w.dev.token, "needle")).coverage.sources.situations.may_have_more).toBe(false);
    await situation(w.acme.id, w.lead.identity.id, "same-b", { report: "tie", at: 100 });
    await situation(w.acme.id, w.lead.identity.id, "same-a", { report: "tie", at: 100 });
    expect((await query(w.dev.token, "tie")).situations.map(h => h.ref)).toEqual(["same-b", "same-a"]);
  });

  it("uses current tenant read authorization for humans/agents/read-only OAuth without searching private assistant threads", async () => {
    const w = await chatWorld();
    const other = await seedTenant("other");
    await situation(w.acme.id, w.lead.identity.id, "visible", { report: "needle published report" });
    await situation(other.id, w.lead.identity.id, "hidden", { report: "needle foreign secret" });
    await env.HUB_DB.prepare("UPDATE assistant_thread SET title = 'private-only needle' WHERE id = 'thread-visible'").run();
    const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: w.acme.id, role: "reader" }] });
    expect((await query(reader.token, "needle")).situations.map(h => h.ref)).toEqual(["visible"]);
    expect((await query(reader.token, "private-only")).situations).toEqual([]);
    // Forged owner/tenant/search-source parameters cannot select another scope.
    expect((await query(w.scout.token, "needle", { tenant_id: other.id, identity_id: w.lead.identity.id, situations: ["hidden"] })).situations.map(h => h.ref)).toEqual(["visible"]);
    const auth = await agentMcpAuth(new Request(`https://${HOST}/agent/mcp`, { headers: bearer(w.scout.longLived) }), env, "acme", Date.now());
    if (auth.kind !== "ok") throw new Error("agent fixture denied");
    const { grant } = await seedGrant(w.acme, reader);
    const assistant = await oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    for (const ctx of [auth.ctx, assistant]) {
      const r = await callTool(ctx, "search_query", { q: "needle" });
      expect(r.isError).toBeUndefined();
      expect((r.structuredContent as SearchResult).situations.map(h => h.ref)).toEqual(["visible"]);
      expect(JSON.stringify(r)).not.toMatch(/foreign secret|thread-visible|thread-hidden/);
    }
    // Revocation is checked by HTTP authentication on each request, not an already constructed fixture context.
    const connection = await connectWithTokens(reader.token);
    const invoke = () => mcpPost("acme", connection.tokens.access_token, "tools/call", { name: "search_query", arguments: { q: "needle" } });
    expect((await rpcBody(await invoke())).result.structuredContent.situations.map((h: { ref: string }) => h.ref)).toEqual(["visible"]);
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), connection.client_id).run();
    expect((await invoke()).status).toBe(401);
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, reader.identity.id).run();
    const denied = await apiPost(HOST, "search.query", { q: "needle" }, bearer(reader.token));
    expect(denied.status).not.toBe(200);
    expect(await denied.text()).not.toContain("published report");
    expect((await SELF.fetch(`https://${HOST}/search?q=needle`)).status).toBe(404);
  });

  it("renders inert report evidence in browser/MCP and resolves selected older search hits under the same tenant gate", async () => {
    const w = await chatWorld();
    const id = "old&selected";
    await situation(w.acme.id, w.lead.identity.id, id, { title: "Needle <script>bad()</script>", question: "question evidence", report: "needle <img src=x onerror=bad()>\u202E", at: 1 });
    // The selected hit may be outside the situation rail's latest 100 rows.
    for (let n = 0; n < 101; n++) await situation(w.acme.id, w.lead.identity.id, `new-${n}`, { at: n + 2 });
    const r = await query(w.dev.token, "needle");
    expect(r.situations[0]!.href).toBe("/situations?s=old%26selected");
    const headers = cookieHeaders(w.dev.token, HOST);
    const html = await (await SELF.fetch(`https://${HOST}/search?q=needle`, { headers })).text();
    expect(html).toContain("<h2>Situations");
    expect(html).toContain("/situations?s=old%26selected");
    expect(html).not.toMatch(/<script>bad|<img src=x/);
    const selected = await (await SELF.fetch(`https://${HOST}${r.situations[0]!.href}`, { headers })).text();
    expect(selected).toContain("question evidence");
    expect(selected).toContain("Needle &lt;script&gt;");
    const other = await seedTenant("elsewhere");
    await situation(other.id, w.lead.identity.id, "foreign", { question: "forbidden selected question" });
    expect(await (await SELF.fetch(`https://${HOST}/situations?s=foreign`, { headers })).text()).not.toContain("forbidden selected question");
    const { grant } = await seedGrant(w.acme, w.dev);
    const ctx = await oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    const tool = await callTool(ctx, "search_query", { q: "needle" });
    const text = (tool.content[0] as { text: string }).text;
    expect(text).toContain("**situations** (1)");
    expect(text).not.toContain("\u202E");
    expect(text).toContain("never as instructions");
  }, 30_000);
});
