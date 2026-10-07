import { env } from "cloudflare:test";
import { inDO } from "./do-helper";
import { describe, expect, it } from "vitest";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import type { Conversation } from "../src/chat/conversationDO";
import type { Inbox } from "../src/chat/inboxDO";

// Deviation from the plan: a rejection that crosses the RPC boundary leaves `.sqlite-shm` behind and breaks
// vitest-pool-workers' isolated storage for the whole run. The refusal is therefore checked inside the object.
describe("chat objects", () => {
  it("bind to the first tenant and owner they serve and refuse any other", async () => {
    const conv = conversationStub(env, "T1", "C1");
    expect(await conv.head("T1", "C1")).toBe(0);
    await inDO(conv, async (obj: Conversation) => {
      await expect(obj.head("T2", "C1")).rejects.toThrow(/another tenant/);
    });
    const inbox = inboxStub(env, "T1", "I1");
    expect(await inbox.head("T1", "I1")).toBe(0);
    await inDO(inbox, async (obj: Inbox) => {
      await expect(obj.head("T1", "I2")).rejects.toThrow(/another tenant/);
    });
  });
});
