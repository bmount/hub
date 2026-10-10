import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildContext, oauthContext } from "../src/auth/context";
import { liveGrant } from "../src/db/oauthGrants";
import { inboxStub } from "../src/chat/stubs";
import { callTool, isQuietPoll } from "../src/mcp/tools";
import { registerAllVerbs } from "../src/verbs/index";
import { getVerb } from "../src/verbs/table";
import { bearer, seedGrant, seedHuman, seedTenant } from "./helpers";
import { channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";

beforeAll(registerAllVerbs);
afterEach(() => vi.restoreAllMocks());

async function world() {
  const tenant = await seedTenant("acme");
  const human = await seedHuman("ann@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const { grant, session } = await seedGrant(tenant, human);
  const ctx = oauthContext(env, (await liveGrant(env.HUB_DB, grant.id, Date.now()))!, ["read"], { now: Date.now(), ip: "203.0.113.1" });
  return { tenant, human, ctx, session };
}
const audits = async () => (await env.HUB_DB.prepare("SELECT kind, target_id, summary FROM event WHERE kind IN ('mcp.call', 'mcp.denied', 'playground.call', 'playground.denied') ORDER BY id").all()).results;

describe("confirmed-empty MCP polling", () => {
  it("does not inflate activity across repeated mail, attention, inbox and catchup polls; logs fixed debug metadata only", async () => {
    const w = await world();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const before = (await env.HUB_DB.prepare("SELECT * FROM event").all()).results;
    const stored = await env.HUB_DB.prepare("SELECT * FROM session WHERE id = ?").bind(w.session.id).first();
    for (let i = 0; i < 3; i++) for (const name of ["mail_list", "attention_list", "chat_inbox", "chat_catchup"]) {
      const result = await callTool(w.ctx, name, {});
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toBeDefined();
    }
    expect((await env.HUB_DB.prepare("SELECT * FROM event").all()).results).toEqual(before);
    expect(await env.HUB_DB.prepare("SELECT * FROM session WHERE id = ?").bind(w.session.id).first()).toEqual(stored);
    expect(debug).toHaveBeenCalledTimes(12);
    for (const [text] of debug.mock.calls) expect(JSON.parse(text)).toEqual({ msg: "mcp.poll", via: "mcp", verb: expect.stringMatching(/^(mail.list|attention.list|chat.inbox|chat.catchup)$/), outcome: "empty" });
    expect(JSON.stringify(debug.mock.calls)).not.toContain(w.human.identity.id);
    expect(await inboxStub(env, w.tenant.id, w.human.identity.id).cursors(w.tenant.id, w.human.identity.id)).toEqual({});
  });

  it("retains nonempty mail and attention audit without recording result contents", async () => {
    const w = await world();
    const privateText = "secret-result-must-never-be-logged";
    await env.HUB_DB.prepare(`INSERT INTO inbound_mail (id, tenant_id, identity_id, from_email, to_address, subject, received_at, size, verdict, text, attachments, forwarded)
      VALUES ('MAIL', ?, ?, 'ann@example.com', 'acme@pimwell.test', ?, ?, 100, 'admitted', ?, '[]', 0)`).bind(w.tenant.id, w.human.identity.id, privateText, Date.now(), privateText).run();
    await env.HUB_DB.prepare(`INSERT INTO attention (id, tenant_id, identity_id, reason, summary, created_at) VALUES ('ATT', ?, ?, 'mention', ?, ?)`).bind(w.tenant.id, w.human.identity.id, privateText, Date.now()).run();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    expect((await callTool(w.ctx, "mail_list", {})).structuredContent).toMatchObject({ mail: [{ id: "MAIL" }] });
    expect((await callTool(w.ctx, "attention_list", {})).structuredContent).toMatchObject({ entries: [{ id: "ATT" }] });
    const trail = await audits();
    expect(trail.map(e => e.target_id).sort()).toEqual(["attention.list", "mail.list"]);
    expect(JSON.stringify(trail)).not.toContain(privateText);
    expect(debug).not.toHaveBeenCalled();
  });

  it("keeps errors and denials audited, including nominally empty poll tools", async () => {
    const w = await world();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    for (const [name, args] of [["mail_list", { limit: 0 }], ["mail_list", { quarantined: true }], ["chat_inbox", { after: 1 }], ["chat_catchup", { since: "forged-private-cursor" }], ["missing_private_tool", { body: "secret" }]] as const) {
      expect((await callTool(w.ctx, name, args)).isError).toBe(true);
    }
    const trail = await audits();
    expect(trail.filter(e => e.kind === "mcp.call")).toHaveLength(5);
    expect(trail.filter(e => e.kind === "mcp.denied")).toHaveLength(1);
    expect(JSON.stringify(trail)).not.toContain("forged-private-cursor");
    expect(JSON.stringify(trail)).not.toContain("secret");
    expect(debug).not.toHaveBeenCalled();
  });

  it("retains internal and rendering failures even when the query would otherwise be empty", async () => {
    const w = await world();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const v = getVerb("mail.list")!;
    vi.spyOn(v, "run").mockRejectedValueOnce(Error("private database failure"));
    expect((await callTool(w.ctx, "mail_list", {})).isError).toBe(true);
    vi.spyOn(v.mcp!, "render").mockImplementationOnce(() => { throw Error("private render failure"); });
    expect((await callTool(w.ctx, "mail_list", {})).isError).toBe(true);
    expect(await audits()).toEqual([
      expect.objectContaining({ target_id: "mail.list", summary: "mail.list internal {}" }),
      expect.objectContaining({ target_id: "mail.list", summary: "mail.list internal {}" }),
    ]);
    expect(debug).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("private");
  });

  it("applies the same empty/nonempty policy to the Playground; other empty queries stay audited", async () => {
    const w = await world();
    const browser = await buildContext(new Request("https://acme.pimwell.test/api/mail.list", { headers: bearer(w.human.token) }), env);
    const ctx = { ...browser, playground: { scopes: ["read"] } };
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    expect((await callTool(ctx, "mail_list", { mine: true })).isError).toBeUndefined();
    expect((await callTool(ctx, "project_list", {})).isError).toBeUndefined();
    expect((await callTool(ctx, "mail_list", { limit: 0 })).isError).toBe(true);
    expect(await audits()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "playground.call", target_id: "project.list" }),
      expect.objectContaining({ kind: "playground.call", target_id: "mail.list", summary: "mail.list bad_request {limit}" }),
    ]));
    expect(await audits()).toHaveLength(2);
    expect(debug).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ msg: "mcp.poll", via: "playground", verb: "mail.list", outcome: "empty" }));
  });

  it("retains agent nonempty and permission-filtered continuation polls, without advancing reads or acknowledging", async () => {
    const w = await chatWorld();
    await channelWith(w, "hidden");
    await channelWith(w, "general");
    await ok(w.lead.token, "chat.post", { c: "hidden", body: "@scout hidden evidence" });
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout visible evidence" });
    await ok(w.lead.token, "channel.remove_agent", { c: "hidden", agent: "scout" });
    // Headless scope enforcement remains in the same shared callTool path.
    const ctx = await buildContext(new Request("https://acme.pimwell.test/api/chat.inbox", { headers: bearer(w.scout.token) }), env);
    const agent = { ...ctx, agentMcp: { token_id: w.scout.apiToken.id, scopes: ["read"], sealed: { ciphertext: "unused", iv: "unused" } } };
    const result = await callTool(agent, "chat_inbox", { limit: 1 });
    expect(result.structuredContent).toMatchObject({ items: [], has_more: true, next_after: 1 });
    expect((await callTool(agent, "chat_inbox", { after: 1 })).structuredContent).toMatchObject({ items: [{ item: 2 }], has_more: false });
    expect((await callTool(agent, "chat_catchup", {})).structuredContent).toMatchObject({ advanced: false, conversations: expect.any(Array) });
    expect((await audits()).map(e => e.target_id).sort()).toEqual(["chat.catchup", "chat.inbox", "chat.inbox"]);
    expect(JSON.stringify(await audits())).not.toContain("evidence");
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect((await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).items.every(i => i.acked_at === null)).toBe(true);
  });

  it("does not suppress polls before authorization or after the OAuth grant is revoked", async () => {
    const w = await world();
    const c = await connectWithTokens(w.human.token);
    const call = async () => rpcBody(await mcpPost("acme", c.tokens.access_token, "tools/call", { name: "mail_list", arguments: {} }));
    const granted = await env.HUB_DB.prepare("SELECT session_id FROM oauth_grant WHERE client_id = ?").bind(c.client_id).first<{ session_id: string }>();
    const stale = Date.now() - 2 * 3600_000;
    await env.HUB_DB.prepare("UPDATE session SET last_seen_at = ? WHERE id = ?").bind(stale, granted!.session_id).run();
    expect((await call()).result.structuredContent).toEqual({ mail: [] });
    expect(await audits()).toEqual([]);
    const touched = await env.HUB_DB.prepare("SELECT last_seen_at FROM session WHERE id = ?").bind(granted!.session_id).first<{ last_seen_at: number }>();
    expect(touched!.last_seen_at).toBeGreaterThan(stale);
    // Authentication's existing coalesced health touch still runs before quiet classification.
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = 1 WHERE client_id = ?").bind(c.client_id).run();
    const denied = await mcpPost("acme", c.tokens.access_token, "tools/call", { name: "mail_list", arguments: {} });
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain('"mail":[]');
  });
});

describe("conservative quiet-poll classification", () => {
  it.each(["mail.list", "attention.list", "chat.inbox", "chat.catchup"])("keeps malformed %s results audited", name => {
    for (const r of [undefined, null, {}, [], { mail: null, entries: null, items: null }, { mail: "", entries: "", items: "" }]) expect(isQuietPoll(getVerb(name)!, r)).toBe(false);
  });
  it("does not mistake compact, omitted or cursor-advancing catchup for inactivity", () => {
    const base = { for_you: [], threads: [], conversations: [], quiet: [], omitted: 0, advanced: false };
    const v = getVerb("chat.catchup")!;
    expect(isQuietPoll(v, base)).toBe(true);
    for (const k of ["for_you", "threads", "conversations", "quiet"]) expect(isQuietPoll(v, { ...base, [k]: [{}] })).toBe(false);
    for (const change of [{ omitted: 1 }, { omitted: undefined }, { advanced: true }, { advanced: undefined }]) expect(isQuietPoll(v, { ...base, ...change })).toBe(false);
    expect(isQuietPoll(getVerb("chat.inbox")!, { items: [], has_more: true })).toBe(false);
    expect(isQuietPoll(getVerb("chat.inbox")!, { items: [] })).toBe(false);
  });
  it("requires explicit query opt-in and exact true; classifier errors retain audit", () => {
    const v = getVerb("project.list")!;
    expect(isQuietPoll(v, { namespaces: [], projects: [] })).toBe(false);
    expect(isQuietPoll({ ...v, quietPoll: () => { throw Error("classifier"); } }, {})).toBe(false);
    expect(isQuietPoll({ ...v, kind: "command", quietPoll: () => true }, {})).toBe(false);
  });
});
