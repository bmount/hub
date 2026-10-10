import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as stubs from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { retainedPresence, PRESENCE_MAX, PRESENCE_TTL_MS, type PresenceRow } from "../src/chat/presence";
import { agentMcpAuth } from "../src/mcp/agentAuth";
import { callTool } from "../src/mcp/tools";
import { bearer } from "./helpers";
import { channelWith, chatWorld, HOST, ok } from "./chat-helpers";
import { inDO } from "./do-helper";

const online = (identity_id: string, last_seen: number): PresenceRow => ({ identity_id, last_seen, status: "online", expires_at: last_seen + PRESENCE_TTL_MS });

describe("presence under server clock rollback", () => {
  it("filters future reports before the directory cap, keeps the exact current-time boundary, and does not mutate input", () => {
    const now = 100_000;
    const current = online("current", now);
    const future = Array.from({ length: PRESENCE_MAX }, (_, i) => online(`future-${i}`, now + i + 1));
    const rows = [...future, current, { ...online("future-offline", now + 1), status: "offline" as const, expires_at: now + 1 }];
    const before = structuredClone(rows);
    expect(retainedPresence(rows, now)).toEqual([current]);
    expect(rows).toEqual(before);
    expect(retainedPresence([future[0]!], now + 1)).toEqual([future[0]]);
  });

  it("returns valid peers instead of impossible future activity, leaves stored reports unchanged on reads, and accepts a fresh explicit replacement", async () => {
    const w = await chatWorld(); await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const stub = stubs.conversationStub(env, w.acme.id, ch.project_id);
    const now = Date.now();
    const rows: PresenceRow[] = [online(w.dev.identity.id, now + 60_000),
      { ...online(w.scout.agent.identity.id, now + 60_000), status: "away" },
      { ...online(w.tidy.agent.identity.id, now + 60_000), status: "offline", expires_at: now + 60_000 },
      online(w.lead.identity.id, now - 1_000)];
    await inDO(stub, (_obj, state) => state.storage.put("presence:v1", rows));
    const stored = () => inDO(stub, (_obj, state) => state.storage.get<PresenceRow[]>("presence:v1"));
    for (let i = 0; i < 2; i++) {
      const result = await ok(w.lead.token, "chat.presence", { c: "general" });
      expect(result.entries.map((r: { identity_id: string }) => r.identity_id)).toEqual([w.lead.identity.id]);
      expect(result.missing).toBe("unknown");
      expect(result.entries[0].state).toBe("online");
      expect(await stored()).toEqual(rows);
    }
    await ok(w.dev.token, "chat.heartbeat", { c: "general", status: "away" });
    const result = await ok(w.lead.token, "chat.presence", { c: "general" });
    expect(result.entries).toHaveLength(2);
    expect(result.entries).toEqual(expect.arrayContaining([expect.objectContaining({ identity_id: w.dev.identity.id, state: "away" })]));
    expect(result.entries.every((r: { last_seen: number }) => r.last_seen <= result.observed_at)).toBe(true);
    expect((await stored())!.filter(r => r.identity_id === w.dev.identity.id)).toHaveLength(1);
    expect(await stub.head(w.acme.id, ch.project_id)).toBe(0);
  });

  it("rechecks the completed snapshot time if the clock rolls back after the DO read, without reviving future offline or assistant reports", async () => {
    const w = await chatWorld(); await channelWith(w, "general", ["scout"]);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const stub = stubs.conversationStub(env, w.acme.id, ch.project_id);
    const now = Date.now();
    const rows: PresenceRow[] = [online(w.dev.identity.id, now),
      { ...online(w.scout.agent.identity.id, now), via_assistant: true, status: "offline", expires_at: now },
      online(w.lead.identity.id, now - 1_000)];
    await inDO(stub, (_obj, state) => state.storage.put("presence:v1", rows));
    const captured = await stub.presence(w.acme.id, ch.project_id); // Real DO read before rollback.
    expect(captured).toHaveLength(3);
    const auth = await agentMcpAuth(new Request(`https://${HOST}/agent/mcp`, { headers: bearer(w.scout.longLived) }), env, "acme", now);
    if (auth.kind !== "ok") throw new Error("fixture auth refused");
    // Deterministically model rollback during the cross-DO/D1 lookup, not OS clock or sleep acceptance.
    const lookup = vi.spyOn(stubs, "conversationStub").mockReturnValue(new Proxy(stub, { get(target, prop) {
      if (prop === "presence") return async () => captured;
      return Reflect.get(target, prop, target);
    } }));
    const time = vi.spyOn(Date, "now").mockReturnValue(now - 100);
    try {
      const result = await callTool(auth.ctx, "chat_presence", { c: "general" });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ observed_at: now - 100, missing: "unknown", entries: [{ identity_id: w.lead.identity.id, state: "online" }] });
      expect((result.structuredContent as { entries: unknown[] }).entries).toHaveLength(1);
    } finally { time.mockRestore(); lookup.mockRestore(); }
    expect(await inDO(stub, (_obj, state) => state.storage.get("presence:v1"))).toEqual(rows);
  });
});
