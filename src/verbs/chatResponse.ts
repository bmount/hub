import { defineVerb } from "./table";
import { channelParam, msgParam } from "./chatParams";
import { notFound } from "../errors";
import { readableChannel, viewerOf } from "../chat/access";
import { chatText, plainText } from "../chat/compact";
import { conversationStub } from "../chat/stubs";
import type { ResponseSlot, ResponseStatus } from "../chat/types";

/** Compact reconciliation evidence, not a permission gate or a task state machine. */
export const chatResponseStatus = defineVerb({
  name: "chat.response_status", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Look up your own durable progress/result chat posts for one source message without sending anything. Records prove only chat posting, not task completion. Missing slots do not rule out ordinary replies; reconcile the original thread before acting.",
  mcp: {
    scope: "read", destructive: false, title: "Reconcile recorded chat responses", render: chatText, auditKeysOnly: true,
    input: {
      type: "object", properties: {
        c: { type: "string", description: "Authorized channel name." },
        msg: { type: ["integer", "string"], description: "Original source message number or exact msg_id. Only the authenticated caller's response slots are returned." },
      }, required: ["c", "msg"], additionalProperties: false,
    },
  },
  parse: (i) => ({ c: channelParam(i), msg: msgParam(i, "msg", true) }),
  run: async (ctx, p) => {
    const v = viewerOf(ctx);
    const ch = await readableChannel(ctx, p.c);
    const r = (await conversationStub(ctx.env, ch.tenant_id, ch.project_id).responseStatus(ch.tenant_id, ch.project_id, v.identity.id, p.msg)) as ResponseStatus | null;
    if (!r) throw notFound("no such source message");
    const line = (stage: string, slot: ResponseSlot | null) => !slot
      ? `${stage}: no durable record (ordinary replies are not tracked here)`
      : `${stage}: recorded #${slot.committed.seq} id=${slot.committed.msg_id} committed_r=${slot.committed.rev}; source_r=${slot.source.rev} author_id=${slot.source.author_id}; ${slot.current ? `current_r=${slot.current.rev}${slot.current.retracted ? " retracted" : ""}` : "current message unavailable"}`;
    return {
      tenant_id: ch.tenant_id, conversation_id: ch.project_id, identity_id: v.identity.id, channel: ch.slug, ...r,
      text: plainText(`#${ch.slug} recorded chat responses head=${r.head}`, [
        `source #${r.source.seq} id=${r.source.msg_id} current_r=${r.source.rev} author_id=${r.source.author_id}${r.source.retracted ? " retracted" : ""}`,
        line("progress", r.progress), line("result", r.result),
        "Records are chat-post evidence only, not task completion or execution authority. Read the original thread and recheck delegated scope before acting.",
      ]),
    };
  },
});
