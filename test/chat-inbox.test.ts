import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { inboxStub } from "../src/chat/stubs";
import type { WakeItem } from "../src/chat/types";

const T = "T1";
const box = (id = "I1") => inboxStub(env, T, id);
const item = (seq: number, over: Partial<WakeItem> = {}): WakeItem => ({
  key: `C1:${seq}:I1`, kind: "mention", conversation_id: "C1", seq, msg_id: `M${seq}`, thread_root: null, hop: 0, author_id: "H1", wake: true,
  created_at: Date.now(), ...over,
});

describe("Inbox object", () => {
  it("stores each item once per key and lists open items in order", async () => {
    expect(await box().deliver(T, "I1", [item(1), item(2)])).toBe(2);
    expect(await box().deliver(T, "I1", [item(2), item(3)])).toBe(1);
    const page = await box().list(T, "I1", { after: 0, limit: 10, include_acked: false });
    expect(page.items.map((i) => [i.item_seq, i.seq, i.wake])).toEqual([[1, 1, true], [2, 2, true], [3, 3, true]]);
    expect(page.head).toBe(3);
    expect((await box().list(T, "I1", { after: 2, limit: 10, include_acked: false })).items.map((i) => i.seq)).toEqual([3]);
  });

  it("acks through an item", async () => {
    await box().deliver(T, "I1", [item(1), item(2), item(3)]);
    expect(await box().ack(T, "I1", 2, Date.now())).toBe(2);
    expect(await box().ack(T, "I1", 2, Date.now())).toBe(0);
    expect((await box().list(T, "I1", { after: 0, limit: 10, include_acked: false })).items.map((i) => i.seq)).toEqual([3]);
    const all = await box().list(T, "I1", { after: 0, limit: 10, include_acked: true });
    expect(all.items.map((i) => i.acked_at !== null)).toEqual([true, true, false]);
  });

  it("long-polls: answers as soon as an item lands, or empty at the deadline", async () => {
    const waiting = box().wait(T, "I1", { after: 0, limit: 10, wait_ms: 5000 });
    const t0 = Date.now();
    await box().deliver(T, "I1", [item(1)]);
    expect((await waiting).items.map((i) => i.seq)).toEqual([1]);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((await box("I2").wait(T, "I2", { after: 0, limit: 10, wait_ms: 200 })).items).toEqual([]);
    expect((await box().wait(T, "I1", { after: 0, limit: 10, wait_ms: 5000 })).items.map((i) => i.seq)).toEqual([1]);
  });

  it("keeps read cursors monotonic", async () => {
    expect(await box().markRead(T, "I1", "C1", 5)).toBe(5);
    expect(await box().markRead(T, "I1", "C1", 3)).toBe(5);
    expect(await box().markRead(T, "I1", "C2", 1)).toBe(1);
    expect(await box().cursors(T, "I1")).toEqual({ C1: 5, C2: 1 });
  });

  it("holds an agent session to 6 posts a minute, per session, with retry_after", async () => {
    const now = Date.now();
    for (let i = 0; i < 6; i++) expect((await box().reserve(T, "I1", { session_id: "S1", is_agent: true, conversation_id: "C1", now: now + i })).ok).toBe(true);
    const r = await box().reserve(T, "I1", { session_id: "S1", is_agent: true, conversation_id: "C1", now: now + 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retry_after_s).toBeGreaterThan(55);
    expect((await box().reserve(T, "I1", { session_id: "S2", is_agent: true, conversation_id: "C1", now: now + 11 })).ok).toBe(true);
    expect((await box().reserve(T, "I1", { session_id: "S1", is_agent: true, conversation_id: "C1", now: now + 61_000 })).ok).toBe(true);
  });

  it("holds a human to 30 posts a minute", async () => {
    const now = Date.now();
    for (let i = 0; i < 30; i++) expect((await box().reserve(T, "I1", { session_id: "S1", is_agent: false, conversation_id: "C1", now: now + i })).ok).toBe(true);
    expect((await box().reserve(T, "I1", { session_id: "S9", is_agent: false, conversation_id: "C1", now: now + 40 })).ok).toBe(false);
  });

  it("reports the hop of the newest open top-level wake in the conversation", async () => {
    await box().deliver(T, "I1", [item(1, { hop: 1 }), item(2, { hop: 2, thread_root: "M1" }), item(3, { hop: 0, wake: false, key: "C1:3:I1" })]);
    const r = await box().reserve(T, "I1", { session_id: "S1", is_agent: true, conversation_id: "C1", now: Date.now() });
    expect(r).toEqual({ ok: true, wake_hop: 1 });
    await box().ack(T, "I1", 3, Date.now());
    expect(await box().reserve(T, "I1", { session_id: "S1", is_agent: true, conversation_id: "C1", now: Date.now() })).toEqual({ ok: true, wake_hop: null });
  });

  it("counts refusals in the last hour", async () => {
    const now = Date.now();
    expect(await box().noteRefusal(T, "I1", now)).toBe(1);
    expect(await box().noteRefusal(T, "I1", now + 1)).toBe(2);
    expect(await box().noteRefusal(T, "I1", now + 3_700_000)).toBe(1);
  });

  it("refuses a request for another binding", async () => {
    await box().head(T, "I1");
    // Checked inside the object: a rejection across RPC breaks vitest-pool-workers' isolated storage (see chat-objects.test.ts).
    await runInDurableObject(box(), async (obj) => {
      await expect(obj.list("T2", "I1", { after: 0, limit: 1, include_acked: false })).rejects.toThrow(/another tenant/);
    });
  });
});
