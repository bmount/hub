import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { conversationStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { retainedPresence, PRESENCE_MAX, PRESENCE_RETENTION_MS, PRESENCE_TTL_MS, type PresenceRow } from "../src/chat/presence";
import { channelWith, chatWorld, ok } from "./chat-helpers";
import { inDO } from "./do-helper";

const online = (identity_id: string, now: number): PresenceRow => ({ identity_id, status: "online", last_seen: now, expires_at: now + PRESENCE_TTL_MS });

describe("duplicate persisted presence subjects are unknown", () => {
  it("omits ambiguous subjects before sorting/capping, independent of order, without mutating input", () => {
    const now = 100_000_000;
    const peer = online("peer", now - 1000);
    const duplicates = Array.from({ length: PRESENCE_MAX + 1 }, () => online("duplicate", now));
    const conflicting = [online("conflict", now - 1), { identity_id: "conflict", status: "offline" as const, last_seen: now, expires_at: now, via_assistant: true }];
    const rows = [...duplicates, ...conflicting, peer];
    const before = structuredClone(rows);
    expect(retainedPresence(rows, now)).toEqual([peer]);
    expect(retainedPresence([...rows].reverse(), now)).toEqual([peer]);
    expect(rows).toEqual(before);
    // Unusable/future/expired observations cannot make an otherwise unambiguous
    // current subject unknown. Deduplication applies only to eligible evidence.
    expect(retainedPresence([peer, { ...peer, status: "invalid" }, online("peer", now + 1), online("peer", now - PRESENCE_RETENTION_MS)], now)).toEqual([peer]);
    const valid = Array.from({ length: PRESENCE_MAX + 1 }, (_, i) => online(`valid-${i}`, now - 2000 - i));
    expect(retainedPresence([...duplicates, ...valid], now)).toEqual(valid.slice(0, PRESENCE_MAX));
  });

  it("keeps API peers readable on repeated read-only polls, then replaces own duplicates only on explicit report", async () => {
    const w = await chatWorld(); await channelWith(w, "general", ["scout"]);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const stub = conversationStub(env, w.acme.id, ch.project_id);
    const now = Date.now();
    const rows = [online(w.dev.identity.id, now), { identity_id: w.dev.identity.id, status: "offline", last_seen: now - 1, expires_at: now - 1 },
      online(w.scout.agent.identity.id, now), { ...online(w.scout.agent.identity.id, now), via_assistant: true }, online(w.lead.identity.id, now - 1000)];
    await inDO(stub, (_obj, state) => state.storage.put("presence:v1", rows));
    const stored = () => inDO(stub, (_obj, state) => state.storage.get("presence:v1"));
    for (let i = 0; i < 2; i++) {
      const snapshot = await ok(w.lead.token, "chat.presence", { c: "general" });
      expect(snapshot).toMatchObject({ missing: "unknown", entries: [{ identity_id: w.lead.identity.id, state: "online" }] });
      expect(snapshot.entries).toHaveLength(1);
      expect(await stored()).toEqual(rows);
    }
    await ok(w.dev.token, "chat.heartbeat", { c: "general", status: "offline" });
    const snapshot = await ok(w.lead.token, "chat.presence", { c: "general" });
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries).toContainEqual(expect.objectContaining({ identity_id: w.dev.identity.id, state: "offline", via_assistant: false }));
    expect(snapshot.entries.map((e: { identity_id: string }) => e.identity_id)).not.toContain(w.scout.agent.identity.id);
    expect(await stub.head(w.acme.id, ch.project_id)).toBe(0);
  });
});
