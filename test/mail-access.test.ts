import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerAllVerbs } from "../src/verbs/index";
import { callTool } from "../src/mcp/tools";
import { agentMcpAuth } from "../src/mcp/agentAuth";
import { liveGrant } from "../src/db/oauthGrants";
import { createProject } from "../src/db/projects";
import { recordEvent } from "../src/db/events";
import { buildContext, oauthContext } from "../src/auth/context";
import { readableMail } from "../src/auth/mailAccess";
import { addCredential } from "../src/models/store";
import { setModelFetchForTest } from "../src/models/providers";
import { apiPost, bearer, cookieHeaders, seedAgent, seedGrant, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
const secret = "mailbound-classified-B";
beforeAll(() => registerAllVerbs());
afterEach(() => setModelFetchForTest(null));

async function world() {
  const t = await seedTenant("acme"), foreign = await seedTenant("elsewhere");
  const pr = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "tracker", display_name: "Site" }, Date.now());
  const human = async (email: string, role: "member" | "reader" | "admin" = "member", root = false) => {
    const h = await seedHuman(email, { is_root: root, memberships: [{ tenant_id: t.id, role }] });
    return { ...h, headers: cookieHeaders(h.token, HOST) };
  };
  const pat = await human("pat@example.com"), lee = await human("lee@example.com"), ordinary = await human("ordinary@example.com"), reader = await human("reader@example.com", "reader"), admin = await human("admin@example.com", "admin"), root = await human("root@example.com", "member", true);
  const a = await seedAgent(t, pat.identity, "a"), b = await seedAgent(t, lee.identity, "b");
  const records = [
    { id: "ORG", recipient: null, project: null, verdict: "admitted" },
    { id: "PROJ", recipient: null, project: pr.id, verdict: "admitted" },
    { id: "PRIVATE-A", recipient: a.agent.identity.id, project: null, verdict: "admitted" },
    { id: "PRIVATE-B", recipient: b.agent.identity.id, project: pr.id, verdict: "admitted" },
    { id: "HELD-A", recipient: a.agent.identity.id, project: null, verdict: "quarantined" },
    { id: "HELD-ORG", recipient: null, project: null, verdict: "quarantined" },
    { id: "FOREIGN", recipient: a.agent.identity.id, project: null, verdict: "admitted" },
  ];
  for (const [index, r] of records.entries()) {
    const tid = r.id === "FOREIGN" ? foreign.id : t.id;
    const subject = r.id === "PRIVATE-B" ? secret : `mailbound-${r.id}`;
    await env.HUB_DB.prepare(`INSERT INTO inbound_mail (id, tenant_id, project_id, recipient_id, identity_id, from_email, to_address, subject, received_at, size, verdict, text, attachments, forwarded)
      VALUES (?, ?, ?, ?, ?, 'pat@example.com', 'acme@pimwell.test', ?, ?, 100, ?, ?, '[]', 0)`).bind(r.id, tid, r.project, r.recipient, pat.identity.id, subject, Date.now() + index, r.verdict, `${subject} body`).run();
    await recordEvent(env.HUB_DB, { tenant_id: tid, identity_id: b.agent.identity.id, session_id: null, kind: "mail.received", target_kind: "inbound_mail", target_id: r.id, summary: subject }, Date.now() + index);
  }
  await env.HUB_DB.prepare(`INSERT INTO outbound_mail (id, tenant_id, from_address, to_address, subject, text, in_reply_to, sent_by, session_id, status, created_at)
    VALUES ('OUT-B', ?, 'acme.b@pimwell.test', 'pat@example.com', ?, ?, 'PRIVATE-B', ?, NULL, 'sent', ?)`).bind(t.id, secret, `${secret} reply`, b.agent.identity.id, Date.now()).run();
  await recordEvent(env.HUB_DB, { tenant_id: t.id, identity_id: b.agent.identity.id, session_id: null, kind: "mail.sent", target_kind: "outbound_mail", target_id: "OUT-B", summary: `${secret} reply` }, Date.now());
  return { t, pr, pat, lee, ordinary, reader, admin, root, a: { ...a, headers: bearer(a.token) }, b: { ...b, headers: bearer(b.token) } };
}

async function list(headers: Record<string, string>, args: Record<string, unknown> = {}) {
  const r = await apiPost(HOST, "mail.list", args, headers);
  expect(r.status, await r.clone().text()).toBe(200);
  const j = await r.json() as { result: { mail: Array<{ id: string }> } };
  return j.result.mail.map((m) => m.id).sort();
}

describe("addressed mailbox access", () => {
  it("filters default/mine:false before paging; humans, agents, operators, readers and admins", async () => {
    const w = await world();
    for (const viewer of [w.ordinary, w.reader]) expect(await list(viewer.headers)).toEqual(["ORG", "PROJ"]);
    for (const viewer of [w.a, w.pat]) expect(await list(viewer.headers, { mine: false })).toEqual(["ORG", "PRIVATE-A", "PROJ"]);
    for (const viewer of [w.b, w.lee]) expect(await list(viewer.headers)).toEqual(["ORG", "PRIVATE-B", "PROJ"]);
    for (const viewer of [w.admin, w.root]) expect(await list(viewer.headers)).toEqual(["ORG", "PRIVATE-A", "PRIVATE-B", "PROJ"]);
    expect(await list(w.a.headers, { mine: true })).toEqual(["PRIVATE-A"]);
    expect(await list(w.ordinary.headers, { limit: 1 })).toEqual(["PROJ"]);
    expect(await list(w.ordinary.headers, { project: "site" })).toEqual(["PROJ"]);
    expect(await list(w.admin.headers, { quarantined: true })).toEqual(["HELD-A", "HELD-ORG"]);
    expect((await apiPost(HOST, "mail.list", { quarantined: true }, w.pat.headers)).status).toBe(404);
  });
  it("denies direct IDs and quarantine even to operators; root remains tenant-bounded", async () => {
    const w = await world();
    for (const viewer of [w.a, w.pat, w.ordinary, w.reader]) {
      for (const id of ["PRIVATE-B", "HELD-A", "HELD-ORG", "FOREIGN"]) expect((await apiPost(HOST, "mail.read", { id }, viewer.headers)).status, id).toBe(404);
    }
    for (const viewer of [w.a, w.pat, w.admin, w.root]) expect((await apiPost(HOST, "mail.read", { id: "PRIVATE-A" }, viewer.headers)).status).toBe(200);
    for (const viewer of [w.admin, w.root]) {
      expect((await apiPost(HOST, "mail.read", { id: "HELD-A" }, viewer.headers)).status).toBe(200);
      expect((await apiPost(HOST, "mail.read", { id: "FOREIGN" }, viewer.headers)).status).toBe(404);
    }
    expect((await apiPost(HOST, "mail.reply", { id: "PRIVATE-B", body: "no" }, w.a.headers)).status).toBe(404);
  });
  it("does not grant agents an admin override even if handed an elevated context", async () => {
    const w = await world();
    const ctx = await buildContext(new Request(`https://${HOST}/api/mail.list`, { headers: w.a.headers }), env);
    const access = readableMail({ ...ctx, role: "admin" });
    const rows = await env.HUB_DB.prepare(`SELECT m.id FROM inbound_mail m WHERE ${access.sql}`).bind(...access.bindings).all<{ id: string }>();
    expect(rows.results.map((r) => r.id).sort()).toEqual(["ORG", "PRIVATE-A", "PROJ"]);
  });
  it("removal of an operator's tenant membership immediately removes mailbox access", async () => {
    const w = await world();
    await env.HUB_DB.prepare("UPDATE membership SET state = 'removed' WHERE identity_id = ? AND tenant_id = ?").bind(w.pat.identity.id, w.t.id).run();
    expect((await apiPost(HOST, "mail.read", { id: "PRIVATE-A" }, w.pat.headers)).status).toBe(404);
    expect((await SELF.fetch(`https://${HOST}/mail/PRIVATE-A`, { headers: w.pat.headers })).status).toBe(404);
  });
  it("re-evaluates operator ownership on the next request", async () => {
    const w = await world();
    await env.HUB_DB.prepare("UPDATE identity SET operator_id = ? WHERE id = ?").bind(w.ordinary.identity.id, w.a.agent.identity.id).run();
    expect((await apiPost(HOST, "mail.read", { id: "PRIVATE-A" }, w.pat.headers)).status).toBe(404);
    expect((await apiPost(HOST, "mail.read", { id: "PRIVATE-A" }, w.ordinary.headers)).status).toBe(200);
  });
  it("applies the same predicate over headless-agent and OAuth assistant MCP tools", async () => {
    const w = await world();
    const auth = await agentMcpAuth(new Request(`https://${HOST}/agent/mcp`, { headers: bearer(w.a.longLived) }), env, "acme", Date.now());
    if (auth.kind !== "ok") throw new Error("fixture agent MCP authentication denied");
    const agentCtx = auth.ctx;
    const { grant } = await seedGrant(w.t, w.pat);
    const assistantCtx = await oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    for (const ctx of [agentCtx, assistantCtx]) {
      for (const tool of ["mail_read", "mail_propose_work"]) {
        const denied = await callTool(ctx, tool, { id: "PRIVATE-B" });
        expect(denied.isError).toBe(true);
        expect(JSON.stringify(denied)).not.toContain(secret);
      }
      for (const [tool, args] of [["mail_list", { mine: false }], ["search_query", { q: "mailbound" }], ["event_list", {}]] as const) {
        const r = await callTool(ctx, tool, args);
        expect(r.isError, `${tool}: ${JSON.stringify(r)}`).toBeUndefined();
        expect(JSON.stringify(r)).not.toContain(secret);
      }
      expect((await callTool(ctx, "mail_read", { id: "PRIVATE-A" })).isError).toBeUndefined();
    }
  });
  it("hides private subjects/body/replies on mail/home/search/people/project pages", async () => {
    const w = await world();
    for (const viewer of [w.ordinary, w.pat, w.a]) {
      for (const path of ["/mail", "/", "/search?q=mailbound", `/people/${encodeURIComponent(w.b.agent.identity.email)}`, "/site"]) {
        const r = await SELF.fetch(`https://${HOST}${path}`, { headers: viewer.headers });
        expect(r.status, path).toBe(200);
        expect(await r.text(), path).not.toContain(secret);
      }
      expect((await SELF.fetch(`https://${HOST}/mail/PRIVATE-B`, { headers: viewer.headers })).status).toBe(404);
    }
    for (const viewer of [w.lee, w.admin]) {
      const r = await SELF.fetch(`https://${HOST}/mail/PRIVATE-B`, { headers: viewer.headers });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain(`${secret} reply`);
    }
  });
  it("filters mail and outgoing event summaries in activity and project history", async () => {
    const w = await world();
    for (const viewer of [w.ordinary, w.pat, w.a]) for (const [verb, args] of [["event.list", {}], ["project.history", { project: "site" }]] as const) {
      const r = await apiPost(HOST, verb, args, viewer.headers);
      expect(r.status).toBe(200);
      expect(await r.text()).not.toContain(secret);
    }
    const r = await apiPost(HOST, "event.list", {}, w.lee.headers);
    expect(await r.text()).toContain(`${secret} reply`);
  });
  it("never sends inaccessible mail to proposal model or consumes its call budget", async () => {
    const w = await world();
    const seen: string[] = [];
    setModelFetchForTest(async (input, init) => {
      if (String(input).endsWith("/v1/models")) return Response.json({ data: [{ id: "gpt-6.1-sol" }] });
      seen.push(String(init?.body));
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: '{"proposals":[]}' }] }], usage: { input_tokens: 10, output_tokens: 5 } });
    });
    await addCredential(env.HUB_DB, env.HUB_SECRETS_KEY, { provider: "openai", label: "", secret: "sk-testAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaaa", tenant_id: null, created_by: null }, Date.now());
    for (const viewer of [w.ordinary, w.pat, w.a]) expect((await apiPost(HOST, "mail.propose_work", { id: "PRIVATE-B" }, viewer.headers)).status).toBe(404);
    expect(seen).toEqual([]);
    expect((await apiPost(HOST, "mail.propose_work", { id: "PRIVATE-A" }, w.pat.headers)).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("mailbound-PRIVATE-A body");
    expect(seen[0]).not.toContain(secret);
  });
});
