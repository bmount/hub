import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversationDO";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import type { PostInput, PostOutcome, VersionInput } from "../src/chat/types";
import { getChannelBySlug } from "../src/db/chat";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { inDO } from "./do-helper";
import { apiPost, bearer, seedTenant } from "./helpers";

async function setup() {
  const w = await chatWorld();
  await channelWith(w);
  const first = await ok(w.scout.token, "chat.post", { c: "general", body: "@tidy original", after: 0 });
  const second = await ok(w.scout.token, "chat.post", { c: "general", body: "second", after: first.head });
  const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
  const args = { c: "general", msg: first.msg_id, body: "private edited checkpoint", after: second.head, idempotency_key: "version-key" };
  return { w, first, second, ch, args, conv: conversationStub(env, w.acme.id, ch.project_id) };
}

describe("exact version intent reconciliation", () => {
  it("refuses changed edit body/message/alias before rates and retains original replay after retraction", async () => {
    const { w, first, second, ch, args, conv } = await setup();
    const edited = await ok(w.scout.token, "chat.edit", args);
    for (let i = 0; i < 25; i++) {
      const denied = await call(w.scout.token, "chat.edit", { ...args, body: "different private text", intent_fingerprint: "forged" });
      expect(denied.body.error).toBe("conflict");
      expect(JSON.stringify(denied.body)).not.toMatch(/private|fingerprint|forged/);
    }
    for (const msg of [second.msg_id, String(first.seq)]) {
      expect((await call(w.scout.token, "chat.edit", { ...args, msg })).body.error).toBe("conflict");
    }
    expect(await ok(w.scout.token, "chat.edit", { ...args, after: edited.head })).toMatchObject({ msg_id: first.msg_id, rev: 2, replayed: true });
    const gone = await ok(w.scout.token, "chat.retract", { c: "general", msg: first.msg_id, idempotency_key: "version-key" });
    expect((await call(w.scout.token, "chat.retract", { c: "general", msg: second.msg_id, idempotency_key: "version-key" })).body.error).toBe("conflict");
    expect(await ok(w.scout.token, "chat.retract", { c: "general", msg: first.msg_id, idempotency_key: "version-key" })).toMatchObject({ rev: gone.rev, replayed: true });
    expect(await ok(w.scout.token, "chat.edit", args)).toMatchObject({ rev: 2, replayed: true });
    expect(await conv.head(w.acme.id, ch.project_id)).toBe(4);
    const history = await ok(w.lead.token, "chat.history", { c: "general", msg: first.msg_id });
    expect(history.versions).toHaveLength(3);
    expect(history.versions[2].retracted).toBe(true);
    const wakes = await inboxStub(env, w.acme.id, w.tidy.agent.identity.id).list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    expect(wakes.items).toHaveLength(1);
    const events = await env.HUB_DB.prepare("SELECT kind, summary FROM event WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.scout.agent.identity.id).all<{ kind: string; summary: string }>();
    expect(events.results.filter((e) => e.kind === "chat.edit")).toHaveLength(1);
    expect(events.results.filter((e) => e.kind === "chat.retract")).toHaveLength(1);
    expect(events.results.some((e) => /private|fingerprint|version-key/.test(e.summary))).toBe(false);
    expect((await call(w.scout.token, "chat.edit", { ...args, msg: second.msg_id, body: "fresh", after: 4, idempotency_key: "fresh" })).status).toBe(200);
  }, 20000);

  it.each(["channel_muted", "agent_muted", "disabled", "archived"])("checks current %s controls before edit replay, preserving retraction mute exemptions", async (control) => {
    const { w, first, args, conv, ch } = await setup();
    const edit = await ok(w.scout.token, "chat.edit", args);
    const gone = await ok(w.scout.token, "chat.retract", { c: "general", msg: first.msg_id, idempotency_key: "retract" });
    if (control === "channel_muted") await ok(w.lead.token, "channel.set_agent_policy", { c: "general", policy: "muted" });
    if (control === "agent_muted") await ok(w.lead.token, "chat.agent_mute", { agent: "scout" });
    if (control === "disabled") await ok(w.lead.token, "chat.agents_disable");
    if (control === "archived") await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await call(w.scout.token, "chat.edit", args)).body.error).toBe(control === "disabled" ? "agents_disabled" : control === "archived" ? "conflict" : "muted");
    const retry = await call(w.scout.token, "chat.retract", { c: "general", msg: first.msg_id, idempotency_key: "retract" });
    if (control.endsWith("muted")) expect(retry.body.result).toMatchObject({ rev: gone.rev, replayed: true });
    else expect(retry.body.error).toBe(control === "disabled" ? "agents_disabled" : "conflict");
    expect(await conv.head(w.acme.id, ch.project_id)).toBe(gone.head);
    expect(edit.rev).toBe(2);
  });

  it("fails closed for legacy records and denies revoked membership before revealing intent conflicts", async () => {
    const { w, args, conv } = await setup();
    await ok(w.scout.token, "chat.edit", args);
    await inDO(conv, (_o, state) => {
      const row = state.storage.sql.exec<{ result_json: string }>("SELECT result_json FROM idem WHERE key = ?", "edit:version-key").toArray()[0]!;
      const stored = JSON.parse(row.result_json);
      state.storage.sql.exec("UPDATE idem SET result_json = ? WHERE key = ?", JSON.stringify(stored.result ?? stored), "edit:version-key");
    });
    expect((await call(w.scout.token, "chat.edit", args)).body.detail).toContain("reconcile");
    expect((await ok(w.lead.token, "chat.history", { c: "general", msg: args.msg })).versions).toHaveLength(2);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const denied = await call(w.scout.token, "chat.edit", { ...args, body: "changed" });
    expect(denied.body.error).toBe("not_found");
    expect(JSON.stringify(denied.body)).not.toContain("intent");
  });

  it("binds native browser edits/retractions and checks archival before cached success", async () => {
    const w = await chatWorld(); await channelWith(w);
    const a = await ok(w.lead.token, "chat.post", { c: "general", body: "native" });
    const args = { c: "general", msg: a.msg_id, body: "native edit", idempotency_key: "browser" };
    const edited = await ok(w.lead.token, "chat.edit", args);
    expect((await call(w.lead.token, "chat.edit", { ...args, body: "different" })).body.error).toBe("conflict");
    expect(await ok(w.lead.token, "chat.edit", args)).toMatchObject({ rev: edited.rev, replayed: true });
    await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await call(w.lead.token, "chat.edit", args)).body.detail).toBe("channel is archived");
  });

  it("keeps actor/channel namespaces separate and refuses cross-tenant reads before replay", async () => {
    const { w, args, first } = await setup();
    const edited = await ok(w.scout.token, "chat.edit", args);
    const human = await ok(w.lead.token, "chat.post", { c: "general", body: "human checkpoint" });
    const ownArgs = { ...args, msg: human.msg_id, body: "human revised", after: human.head };
    const own = await ok(w.lead.token, "chat.edit", ownArgs);
    expect(own.msg_id).not.toBe(edited.msg_id);
    await channelWith(w, "other");
    const other = await ok(w.scout.token, "chat.post", { c: "other", body: "other", after: 0 });
    expect(await ok(w.scout.token, "chat.edit", { ...args, c: "other", msg: other.msg_id, after: other.head })).toMatchObject({ msg_id: other.msg_id, replayed: false });
    expect(await ok(w.scout.token, "chat.edit", { ...args, after: own.head })).toMatchObject({ msg_id: first.msg_id, replayed: true });
    await seedTenant("beta2");
    const denied = await apiPost("beta2.pimwell.test", "chat.edit", args, bearer(w.scout.token));
    // The API hides tenants where this agent-run principal has no membership.
    expect(denied.status).toBe(404);
    expect(JSON.stringify(await denied.json())).not.toContain(first.msg_id);
  });

  it("records one edit event for simultaneous identical endpoint retries", async () => {
    const { w, args, conv, ch } = await setup();
    const outcomes = await Promise.all([call(w.scout.token, "chat.edit", args), call(w.scout.token, "chat.edit", args)]);
    expect(outcomes.map((r) => r.status)).toEqual([200, 200]);
    expect(outcomes.filter((r) => r.body.result.replayed)).toHaveLength(1);
    expect(await conv.head(w.acme.id, ch.project_id)).toBe(3);
    const events = await env.HUB_DB.prepare("SELECT kind FROM event WHERE tenant_id = ? AND kind = 'chat.edit'").bind(w.acme.id).all();
    expect(events.results).toHaveLength(1);
  });

  it("atomically binds concurrent versions and persists replay across new object/session, with unchanged expiry", async () => {
    const tenant = `T${crypto.randomUUID()}`, channel = "C", conv = conversationStub(env, tenant, channel), now = Date.now();
    const author = { id: "H", kind: "human" as const, session_id: "S", session_kind: "browser" as const };
    const p: PostInput = { tenant_id: tenant, conversation_id: channel, now, author, policy: "open", body: "original", body_sha256: "hash", after: null, reply_to: null, refs: [], mentions: [], wake_hop: null, thread_wake_hops: {}, idempotency_key: null, audience: { agent_members: [], operators: {}, muted_agents: [], agents_enabled: true } };
    const first = await conv.post(p); if (first.refused !== null) throw new Error(first.refused);
    const v: VersionInput = { tenant_id: tenant, conversation_id: channel, now, actor: author, msg: first.msg_id, body: "one", body_sha256: "one", after: null, refs: [], mentions: [], operator_of: [], is_admin: false, idempotency_key: "key" };
    const outcomes = await Promise.all([conv.version(v), conv.version({ ...v, body: "two", body_sha256: "two" })]) as PostOutcome[];
    expect(outcomes.filter((o) => o.refused === null)).toHaveLength(1);
    expect(outcomes.filter((o) => o.refused === "conflict")).toHaveLength(1);
    const history = (await conv.history(tenant, channel, first.msg_id))!;
    const retry = { ...v, body: history.versions[1]!.body, actor: { ...author, session_id: "new-session" } };
    expect(await inDO(conv, async (_o, state) => {
      const row = state.storage.sql.exec<{ result_json: string }>("SELECT result_json FROM idem WHERE key = ?", "edit:key").toArray()[0]!;
      expect(JSON.parse(row.result_json).fingerprint).toMatch(/^[a-f0-9]{64}$/);
      return new Conversation(state, env).version(retry);
    })).toMatchObject({ rev: 2, replayed: true });
    expect(await conv.head(tenant, channel)).toBe(2);
    expect(await conv.version({ ...retry, now: now + 25 * 3600000 })).toMatchObject({ rev: 3, replayed: false });
  });
});
