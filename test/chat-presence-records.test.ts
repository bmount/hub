import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { conversationStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { retainedPresence, PRESENCE_MAX, PRESENCE_TTL_MS, type PresenceRow } from "../src/chat/presence";
import { channelWith, chatWorld, ok } from "./chat-helpers";
import { inDO } from "./do-helper";

const online = (identity_id: string, now: number): PresenceRow => ({ identity_id, status: "online", last_seen: now, expires_at: now + PRESENCE_TTL_MS });

describe("unusable persisted presence is unknown", () => {
  it("validates each row before sorting/capping without coercion, timestamp repair or input mutation", () => {
    const now = 100_000;
    const valid = online("valid", now - 1);
    const row = online("bad", now);
    const malformed: unknown[] = [null, false, 1, "online", {},
      { ...row, identity_id: "" }, { ...row, identity_id: 1 },
      { ...row, status: "working" }, { ...row, status: null },
      { ...row, last_seen: "100000" }, { ...row, last_seen: 0.5 },
      { ...row, last_seen: -1 }, { ...row, last_seen: NaN },
      { ...row, expires_at: Infinity }, { ...row, expires_at: "190000" },
      { ...row, expires_at: now - 1 }, { ...row, expires_at: now },
      { ...row, expires_at: now + PRESENCE_TTL_MS + 1 },
      { ...row, status: "offline", expires_at: now + 1 },
      { ...row, last_seen: 8640000000000001, expires_at: 8640000000000001 },
      { ...row, via_assistant: "false" }, { ...row, via_assistant: null },
    ];
    const unbounded = Array.from({ length: PRESENCE_MAX }, (_, i) => ({ ...row, identity_id: `unbounded-${i}`, expires_at: now + PRESENCE_TTL_MS + 1 }));
    expect(retainedPresence([...unbounded, valid], now)).toEqual([valid]);
    const rows = [...malformed, ...unbounded, valid];
    const before = structuredClone(rows);
    expect(retainedPresence(rows, now)).toEqual([valid]);
    expect(rows).toEqual(before);
    const offline = { ...row, status: "offline" as const, expires_at: now };
    const short = { ...row, identity_id: "short", expires_at: now + 1, via_assistant: false };
    expect(retainedPresence([offline, short, { ...valid, via_assistant: true }], now)).toEqual([offline, short, { ...valid, via_assistant: true }]);
    for (const container of [null, {}, "online", 12]) expect(retainedPresence(container, now)).toEqual([]);
  });

  it("keeps valid peers readable with invalid stored rows and replaces own malformed report only on explicit heartbeat", async () => {
    const w = await chatWorld(); await channelWith(w, "general", ["scout"]);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const stub = conversationStub(env, w.acme.id, ch.project_id);
    const now = Date.now();
    const rows = [null, { ...online(w.dev.identity.id, now), expires_at: now + 10 * PRESENCE_TTL_MS },
      { ...online(w.scout.agent.identity.id, now), via_assistant: "false" }, online(w.lead.identity.id, now - 1_000)];
    await inDO(stub, (_obj, state) => state.storage.put("presence:v1", rows));
    const stored = () => inDO(stub, (_obj, state) => state.storage.get("presence:v1"));
    for (let i = 0; i < 2; i++) {
      const snapshot = await ok(w.lead.token, "chat.presence", { c: "general" });
      expect(snapshot).toMatchObject({ missing: "unknown", entries: [{ identity_id: w.lead.identity.id, state: "online" }] });
      expect(snapshot.entries).toHaveLength(1);
      expect(await stored()).toEqual(rows);
    }
    await ok(w.dev.token, "chat.heartbeat", { c: "general", status: "away" });
    const snapshot = await ok(w.lead.token, "chat.presence", { c: "general" });
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries).toContainEqual(expect.objectContaining({ identity_id: w.dev.identity.id, state: "away", via_assistant: false }));
    expect(await stub.head(w.acme.id, ch.project_id)).toBe(0);
  });

  it("reads a malformed container as unknown without repair and accepts a fresh explicit report", async () => {
    const w = await chatWorld(); await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const stub = conversationStub(env, w.acme.id, ch.project_id);
    const container = { identity_id: w.dev.identity.id, status: "online", last_seen: Date.now() };
    await inDO(stub, (_obj, state) => state.storage.put("presence:v1", container));
    expect(await ok(w.lead.token, "chat.presence", { c: "general" })).toMatchObject({ entries: [], missing: "unknown" });
    expect(await inDO(stub, (_obj, state) => state.storage.get("presence:v1"))).toEqual(container);
    await ok(w.dev.token, "chat.heartbeat", { c: "general", status: "offline" });
    expect(await ok(w.lead.token, "chat.presence", { c: "general" })).toMatchObject({ entries: [{ identity_id: w.dev.identity.id, state: "offline" }] });
    expect(await stub.head(w.acme.id, ch.project_id)).toBe(0);
  });
});
