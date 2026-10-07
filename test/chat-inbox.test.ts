import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { inboxStub } from "../src/chat/stubs";
import type { WakeItem } from "../src/chat/types";
import { until } from "./chat-helpers";

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
    // Deliver only once the poll is parked, so it is the delivery that answers it.
    await until(async () => (await box().waiting(T, "I1")) === 1, "the poll to park");
    await box().deliver(T, "I1", [item(1)]);
    expect((await waiting).items.map((i) => i.seq)).toEqual([1]);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((await box("I2").wait(T, "I2", { after: 0, limit: 10, wait_ms: 200 })).items).toEqual([]);
    expect((await box().wait(T, "I1", { after: 0, limit: 10, wait_ms: 5000 })).items.map((i) => i.seq)).toEqual([1]);
  });

  it("keeps waiting after a delivery that does not qualify, until the deadline", async () => {
    const t0 = Date.now();
    const waiting = box().wait(T, "I1", { after: 5, limit: 10, wait_ms: 900 });
    await until(async () => (await box().waiting(T, "I1")) === 1, "the poll to park");
    await box().deliver(T, "I1", [item(1)]);
    expect((await waiting).items).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(850);
    expect(await box().waiting(T, "I1")).toBe(0);
  });

  it("clamps the limit to 1..100", async () => {
    await box().deliver(T, "I1", Array.from({ length: 120 }, (_, i) => item(i + 1)));
    expect((await box().list(T, "I1", { after: 0, limit: 0, include_acked: false })).items.length).toBe(1);
    expect((await box().list(T, "I1", { after: 0, limit: -5, include_acked: false })).items.length).toBe(1);
    expect((await box().list(T, "I1", { after: 0, limit: 1_000_000, include_acked: false })).items.length).toBe(100);
    expect((await box().wait(T, "I1", { after: 0, limit: 1_000_000, wait_ms: 0 })).items.length).toBe(100);
  });

  it("caps concurrent waiters: the ninth poll answers at once, and every waiter cleans up", async () => {
    const parked = Array.from({ length: 8 }, () => box().wait(T, "I1", { after: 0, limit: 10, wait_ms: 3000 }));
    await until(async () => (await box().waiting(T, "I1")) === 8, "eight polls to park");
    const t0 = Date.now();
    expect((await box().wait(T, "I1", { after: 0, limit: 10, wait_ms: 3000 })).items).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await box().waiting(T, "I1")).toBe(8);
    await box().deliver(T, "I1", [item(1)]);
    for (const r of await Promise.all(parked)) expect(r.items.map((i) => i.seq)).toEqual([1]);
    expect(await box().waiting(T, "I1")).toBe(0);
  });

  it("holds a poll at most 20 seconds whatever it asks, and leaves no waiter behind", { timeout: 45_000 }, async () => {
    const t0 = Date.now();
    expect((await box().wait(T, "I1", { after: 0, limit: 10, wait_ms: 600_000 })).items).toEqual([]);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(19_500);
    expect(took).toBeLessThan(25_000);
    expect(await box().waiting(T, "I1")).toBe(0);
  });

  it("prunes acked items after 30 days, on delivery, and keeps newer ones", async () => {
    await box().deliver(T, "I1", [item(1), item(2)]);
    await box().ack(T, "I1", 1, Date.now() - 31 * 86_400_000);
    await box().ack(T, "I1", 2, Date.now() - 29 * 86_400_000);
    await box().deliver(T, "I1", [item(3)]);
    const all = await box().list(T, "I1", { after: 0, limit: 10, include_acked: true });
    expect(all.items.map((i) => i.seq)).toEqual([2, 3]);
    expect(all.head).toBe(3);
  });

  it("returns the newest open wake hop per scope, its thread root or its own message", async () => {
    await box().deliver(T, "I1", [item(1, { hop: 0 }), item(2, { hop: 1, thread_root: "M1" }), item(3, { hop: 2, thread_root: "M3x" }), item(4, { hop: 0, wake: false })]);
    const r = await box().reserve(T, "I1", { session_id: "S1", is_agent: true, conversation_id: "C1", now: Date.now() });
    expect(r).toEqual({ ok: true, wake_hop: 2, thread_wake_hops: { M3x: 2, M1: 1 } });
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

  it("reports the hop of the newest recent wake anywhere in the conversation (C-7)", async () => {
    await box().deliver(T, "I1", [item(1, { hop: 1 }), item(2, { hop: 2, thread_root: "M1" }), item(3, { hop: 0, wake: false, key: "C1:3:I1" })]);
    const r = await box().reserve(T, "I1", { session_id: "S1", is_agent: true, conversation_id: "C1", now: Date.now() });
    expect(r).toEqual({ ok: true, wake_hop: 2, thread_wake_hops: { M1: 2 } });
    await box().ack(T, "I1", 3, Date.now());
    // Acked or not, a wake counts as the cause for 10 minutes (ruling C-4); after that it does not.
    expect(await box().reserve(T, "I1", { session_id: "S1", is_agent: true, conversation_id: "C1", now: Date.now() })).toEqual({ ok: true, wake_hop: 2, thread_wake_hops: { M1: 2 } });
    expect(await box().reserve(T, "I1", { session_id: "S1", is_agent: true, conversation_id: "C1", now: Date.now() + 11 * 60_000 })).toEqual({ ok: true, wake_hop: null, thread_wake_hops: {} });
  });

  it("counts refusals in the last hour", async () => {
    const now = Date.now();
    expect(await box().noteRefusal(T, "I1", now)).toEqual({ count: 1, tripped: false });
    expect(await box().noteRefusal(T, "I1", now + 1)).toEqual({ count: 2, tripped: false });
    expect(await box().noteRefusal(T, "I1", now + 3_700_000)).toEqual({ count: 1, tripped: false });
  });

  it("trips on the 21st refusal in an hour and starts a fresh window", async () => {
    const now = Date.now();
    for (let i = 1; i <= 20; i++) expect((await box().noteRefusal(T, "I1", now + i)).tripped).toBe(false);
    expect(await box().noteRefusal(T, "I1", now + 21)).toEqual({ count: 21, tripped: true });
    expect(await box().noteRefusal(T, "I1", now + 22)).toEqual({ count: 1, tripped: false });
  });

  it("refuses a request for another binding", async () => {
    await box().head(T, "I1");
    // Checked inside the object: a rejection across RPC breaks vitest-pool-workers' isolated storage (see chat-objects.test.ts).
    await runInDurableObject(box(), async (obj) => {
      await expect(obj.list("T2", "I1", { after: 0, limit: 1, include_acked: false })).rejects.toThrow(/another tenant/);
    });
  });
});
