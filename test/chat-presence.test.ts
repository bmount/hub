import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { presenceState, retainedPresence, PRESENCE_TTL_MS, PRESENCE_RETENTION_MS, PRESENCE_MAX, type PresenceRow } from "../src/chat/presence";
import { HOST, call, channelWith, chatWorld, ok } from "./chat-helpers";
import { apiPost, bearer, cookieHeaders, seedHuman, seedTenant } from "./helpers";
import { inDO } from "./do-helper";
import { ASSETS } from "../src/assets";
import type { Conversation } from "../src/chat/conversationDO";

const stubFor = async (tenant: string, slug = "general") => {
  const ch = (await getChannelBySlug(env.HUB_DB, tenant, slug))!;
  return { ch, stub: conversationStub(env, tenant, ch.project_id) };
};

describe("explicit expiring channel presence", () => {
  it("expires at the exact boundary, keeps explicit offline distinct from stale, and bounds retention", () => {
    const row: PresenceRow = { identity_id: "a", status: "online", last_seen: 1000, expires_at: 1000 + PRESENCE_TTL_MS };
    expect(presenceState(row, row.expires_at - 1)).toBe("online");
    expect(presenceState(row, row.expires_at)).toBe("stale");
    expect(presenceState({ ...row, status: "away" }, row.expires_at)).toBe("stale");
    expect(presenceState({ ...row, status: "offline" }, row.expires_at + 1)).toBe("offline");
    const now = PRESENCE_RETENTION_MS + 1000;
    expect(retainedPresence([row], now)).toEqual([]);
    expect(retainedPresence([row], now - 1)).toEqual([row]);
    const rows = Array.from({ length: PRESENCE_MAX + 10 }, (_, i) => ({ ...row, identity_id: String(i), last_seen: now - i }));
    expect(retainedPresence(rows.reverse(), now).map((r) => r.identity_id)).toEqual(Array.from({ length: PRESENCE_MAX }, (_, i) => String(i)));
  });

  it("never manufactures presence from GET/read/post; own heartbeat uses authoritative identity and time and changes no message/cursor/inbox state", async () => {
    const w = await chatWorld(); await channelWith(w);
    await SELF.fetch(`https://${HOST}/c/general`, { headers: cookieHeaders(w.dev.token, HOST) });
    await ok(w.dev.token, "chat.read", { c: "general" });
    await ok(w.dev.token, "chat.post", { c: "general", body: "hello" });
    expect((await ok(w.dev.token, "chat.presence", { c: "general" })).entries).toEqual([]);
    const now = Date.now();
    const heartbeat = await ok(w.dev.token, "chat.heartbeat", { c: "general", status: "online", identity_id: w.lead.identity.id, now: 0, expires_at: 9999999999999, ttl_ms: 999999999 });
    expect(heartbeat.identity_id).toBe(w.dev.identity.id);
    expect(heartbeat.last_seen).toBeGreaterThanOrEqual(now);
    expect(heartbeat.expires_at - heartbeat.last_seen).toBe(PRESENCE_TTL_MS);
    const result = await ok(w.lead.token, "chat.presence", { c: "general" });
    expect(result).toMatchObject({ channel: "general", missing: "unknown", entries: [{ identity_id: w.dev.identity.id, handle: "dev", kind: "human", state: "online" }] });
    await ok(w.dev.token, "chat.heartbeat", { c: "general", status: "away" });
    expect((await ok(w.lead.token, "chat.presence", { c: "general" })).entries[0].state).toBe("away");
    await ok(w.dev.token, "chat.heartbeat", { c: "general", status: "offline" });
    const entries = (await ok(w.lead.token, "chat.presence", { c: "general" })).entries;
    expect(entries).toHaveLength(1); expect(entries[0].state).toBe("offline");
    const { stub, ch } = await stubFor(w.acme.id);
    expect(await stub.head(w.acme.id, ch.project_id)).toBe(1);
    expect((await ok(w.dev.token, "chat.conversations")).conversations[0].read_seq).toBe(0);
    expect((await inboxStub(env, w.acme.id, w.lead.identity.id).list(w.acme.id, w.lead.identity.id, { after: 0, limit: 50, include_acked: true })).items).toEqual([]);
  });

  it("reads presence without backfilling subject or unrelated membership handles", async () => {
    const w = await chatWorld(); await channelWith(w, "general", ["scout"]);
    await ok(w.dev.token, "chat.heartbeat", { c: "general", status: "online" });
    await ok(w.scout.token, "chat.heartbeat", { c: "general", status: "away" });
    await env.HUB_DB.prepare("UPDATE membership SET handle = NULL, handle_skeleton = NULL WHERE tenant_id = ?").bind(w.acme.id).run();
    const memberships = () => env.HUB_DB.prepare("SELECT * FROM membership WHERE tenant_id = ? ORDER BY id").bind(w.acme.id).all();
    const before = (await memberships()).results;
    for (let i = 0; i < 2; i++) {
      const result = await ok(w.lead.token, "chat.presence", { c: "general" });
      expect(result.entries).toHaveLength(2);
      expect(result.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ identity_id: w.dev.identity.id, handle: "unknown", kind: "human", state: "online" }),
        expect.objectContaining({ identity_id: w.scout.agent.identity.id, handle: "unknown", kind: "agent", state: "away" }),
      ]));
      expect((await memberships()).results).toEqual(before);
    }
  });

  it("resolves a full bounded directory in SQL-sized chunks with active tenant subjects only", async () => {
    const w = await chatWorld(); await channelWith(w);
    const { stub } = await stubFor(w.acme.id);
    const now = Date.now();
    const foreign = await seedTenant("presence-foreign");
    const rows: PresenceRow[] = [];
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < PRESENCE_MAX; i++) {
      const id = `presence-subject-${i}`;
      rows.push({ identity_id: id, status: "online", last_seen: now, expires_at: now + PRESENCE_TTL_MS });
      statements.push(env.HUB_DB.prepare("INSERT INTO identity (id, kind, display_name, email, state, created_at) VALUES (?, 'human', ?, ?, ?, ?)")
        .bind(id, `<Subject ${i}>`, `${id}@example.com`, i === 90 ? "archived" : "active", now));
      statements.push(env.HUB_DB.prepare("INSERT INTO membership (id, identity_id, tenant_id, role, state, created_at) VALUES (?, ?, ?, 'reader', ?, ?)")
        .bind(id, id, i === 180 ? foreign.id : w.acme.id, i === 199 ? "archived" : "active", now));
    }
    await env.HUB_DB.batch(statements);
    await inDO(stub, (_obj, state) => state.storage.put("presence:v1", rows));
    const entries = (await ok(w.lead.token, "chat.presence", { c: "general" })).entries;
    expect(entries.map((r: { identity_id: string }) => r.identity_id)).toEqual(rows.filter((_, i) => ![90, 180, 199].includes(i)).map(r => r.identity_id));
    expect(entries.every((r: { handle: string }) => r.handle === "unknown")).toBe(true);
    expect(entries[91].display_name).toBe("<Subject 92>");
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM membership WHERE id LIKE 'presence-subject-%' AND handle IS NOT NULL").first<{ n: number }>())!.n).toBe(0);
  });

  it("serializes concurrent identities and bounds stored state while replacing the caller's previous heartbeat", async () => {
    const w = await chatWorld(); await channelWith(w);
    const { stub, ch } = await stubFor(w.acme.id);
    const now = Date.now();
    await inDO(stub, (_obj, state) => state.storage.put("presence:v1", Array.from({ length: PRESENCE_MAX }, (_, i) => ({
      identity_id: `old-${i}`, status: "online", last_seen: now - i - 1000, expires_at: now - 1,
    }))));
    await Promise.all([
      stub.heartbeat(w.acme.id, ch.project_id, w.dev.identity.id, "online"),
      stub.heartbeat(w.acme.id, ch.project_id, w.lead.identity.id, "away"),
    ]);
    const rows = await stub.presence(w.acme.id, ch.project_id);
    expect(rows).toHaveLength(PRESENCE_MAX);
    expect(rows.some((r) => r.identity_id === w.dev.identity.id)).toBe(true);
    expect(rows.some((r) => r.identity_id === w.lead.identity.id)).toBe(true);
    await stub.heartbeat(w.acme.id, ch.project_id, w.dev.identity.id, "offline");
    expect((await stub.presence(w.acme.id, ch.project_id)).filter((r) => r.identity_id === w.dev.identity.id)).toMatchObject([{ status: "offline" }]);
    expect(await inDO(stub, (_obj, state) => state.storage.get<PresenceRow[]>("presence:v1"))).toHaveLength(PRESENCE_MAX);
  });

  it("marks an expired heartbeat stale without reading renewing it and excludes old records", async () => {
    const w = await chatWorld(); await channelWith(w);
    const { stub } = await stubFor(w.acme.id);
    const now = Date.now();
    await inDO(stub, (_obj, state) => state.storage.put("presence:v1", [
      { identity_id: w.dev.identity.id, status: "online", last_seen: now - PRESENCE_TTL_MS, expires_at: now - 1 },
      { identity_id: w.lead.identity.id, status: "online", last_seen: now - PRESENCE_RETENTION_MS, expires_at: now - 1 },
    ]));
    const result = await ok(w.dev.token, "chat.presence", { c: "general" });
    expect(result.entries).toMatchObject([{ identity_id: w.dev.identity.id, state: "stale", last_seen: now - PRESENCE_TTL_MS }]);
    expect(result.entries).toHaveLength(1);
    expect((await ok(w.dev.token, "chat.presence", { c: "general" })).entries).toEqual(result.entries);
  });

  it("requires active channel grants for agents and hides removed subjects immediately", async () => {
    const w = await chatWorld(); await channelWith(w, "general", ["scout"]);
    for (const verb of ["chat.heartbeat", "chat.presence"]) {
      expect((await call(w.tidy.token, verb, { c: "general", status: "online" })).status).toBe(404);
    }
    await ok(w.scout.token, "chat.heartbeat", { c: "general", status: "online" });
    // Existing handles remain intact; queries do not allocate missing ones.
    await env.HUB_DB.prepare("UPDATE membership SET handle = 'scout', handle_skeleton = 'scout' WHERE tenant_id = ? AND identity_id = ?")
      .bind(w.acme.id, w.scout.agent.identity.id).run();
    expect((await ok(w.dev.token, "chat.presence", { c: "general" })).entries[0]).toMatchObject({ kind: "agent", handle: "scout" });
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    expect((await ok(w.dev.token, "chat.presence", { c: "general" })).entries).toEqual([]);
    expect((await call(w.scout.token, "chat.presence", { c: "general" })).status).toBe(404);
    await ok(w.dev.token, "chat.heartbeat", { c: "general", status: "online" });
    // Test fixture only: no real memberships are changed by the worker.
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.dev.identity.id).run();
    expect((await ok(w.lead.token, "chat.presence", { c: "general" })).entries).toEqual([]);
    expect((await call(w.dev.token, "chat.heartbeat", { c: "general", status: "online" })).status).toBe(404);
  });

  it("isolates channels/tenants including equal slugs, denies archived channels and wrong DO binding", async () => {
    const w = await chatWorld(); await channelWith(w); await channelWith(w, "elsewhere", []);
    await ok(w.dev.token, "chat.heartbeat", { c: "general", status: "online" });
    expect((await ok(w.dev.token, "chat.presence", { c: "elsewhere" })).entries).toEqual([]);
    const other = await seedTenant("other");
    const outsider = await seedHuman("outsider@example.com", { memberships: [{ tenant_id: other.id, role: "admin" }] });
    const host = "other.pimwell.test";
    expect((await apiPost(host, "channel.create", { slug: "general" }, bearer(outsider.token))).status).toBe(200);
    const r = await apiPost(host, "chat.presence", { c: "general" }, bearer(outsider.token));
    expect(await r.json()).toMatchObject({ ok: true, result: { entries: [] } });
    for (const verb of ["chat.presence", "chat.heartbeat"]) {
      expect((await call(outsider.token, verb, { c: "general", status: "online" })).status).toBe(404);
      expect((await apiPost(host, verb, { c: "general", status: "online" }, bearer(w.dev.token))).status).toBe(404);
    }
    const { stub, ch } = await stubFor(w.acme.id);
    const refused = await inDO(stub, async (obj: Conversation) => {
      const errors = [];
      try { await obj.presence(other.id, ch.project_id); } catch { errors.push("tenant"); }
      try { await obj.heartbeat(w.acme.id, "wrong-channel", w.dev.identity.id, "online"); } catch { errors.push("channel"); }
      return errors;
    });
    expect(refused).toEqual(["tenant", "channel"]);
    await ok(w.lead.token, "channel.archive", { c: "general" });
    for (const verb of ["chat.presence", "chat.heartbeat"]) expect((await call(w.lead.token, verb, { c: "general", status: "online" })).status).toBe(404);
    const html = await (await SELF.fetch(`https://${HOST}/c/general`, { headers: cookieHeaders(w.dev.token, HOST) })).text();
    expect(html).not.toContain("data-chat-presence");
  });

  it("enforces cookie origin, authentication, valid statuses and allows readers to publish only themselves", async () => {
    const w = await chatWorld(); await channelWith(w);
    const reader = await seedHuman("reader@example.com", { memberships: [{ tenant_id: w.acme.id, role: "reader" }] });
    expect((await ok(reader.token, "chat.heartbeat", { c: "general", status: "online" })).identity_id).toBe(reader.identity.id);
    expect((await call(reader.token, "chat.heartbeat", { c: "general", status: "working" })).status).toBe(400);
    expect((await call(reader.token, "chat.heartbeat", { c: "general" })).status).toBe(400);
    expect((await apiPost(HOST, "chat.presence", { c: "general" })).status).toBe(404);
    for (const verb of ["chat.presence", "chat.heartbeat"]) {
      const res = await apiPost(HOST, verb, { c: "general", status: "online" }, { ...cookieHeaders(reader.token, HOST), origin: "https://evil.example" });
      expect(res.status).toBe(403);
    }
  });

  it("serves opt-in external browser presence on channels and threads, never discovery, with safe script rendering", async () => {
    const w = await chatWorld(); await channelWith(w);
    await ok(w.lead.token, "chat.post", { c: "general", body: "root" });
    for (const path of ["/c/general", "/c/general/t/1"]) {
      const html = await (await SELF.fetch(`https://${HOST}${path}`, { headers: cookieHeaders(w.dev.token, HOST) })).text();
      expect(html).toContain('data-chat-presence="general"');
      expect(html).toContain("Loading or reading this page does not publish a heartbeat.");
      expect(html).toContain("Current status is unknown.");
      expect(html).toContain(`<script defer src="${ASSETS.presence.path}"></script>`);
    }
    const html = await (await SELF.fetch(`https://${HOST}/c`, { headers: cookieHeaders(w.dev.token, HOST) })).text();
    expect(html).not.toContain("data-chat-presence");
    const script = await SELF.fetch(`https://${HOST}${ASSETS.presence.path}`);
    expect(script.status).toBe(200); expect(script.headers.get("content-type")).toContain("javascript");
    const js = await script.text();
    expect(js).toContain("li.textContent"); expect(js).not.toContain("innerHTML");
    expect(js).toContain("performance.now()"); expect(js).toContain("state = expired");
    expect(js).toContain("entries = []; list.replaceChildren()");
    expect((await ok(w.dev.token, "chat.presence", { c: "general" })).entries).toEqual([]);
  });
});
