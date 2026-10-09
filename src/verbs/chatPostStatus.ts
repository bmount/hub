import { defineVerb } from "./table";
import { channelParam } from "./chatParams";
import { reqString } from "./params";
import { readableChannel, viewerOf } from "../chat/access";
import { chatText, plainText } from "../chat/compact";
import { conversationStub } from "../chat/stubs";
import type { PostStatus } from "../chat/types";

export const chatPostStatus = defineVerb({
  name: "chat.post_status", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Reconcile your own ordinary chat-post key without sending or guessing its payload. Only unexpired 24-hour records are returned; missing records do not prove nothing was sent. Source-bound replies use chat_response_status instead. This is posting evidence, not execution authority or payload verification.",
  mcp: {
    scope: "read", destructive: false, title: "Reconcile an ordinary chat post", render: chatText, auditKeysOnly: true,
    input: {
      type: "object", properties: {
        c: { type: "string", description: "Authorized channel name." },
        idempotency_key: { type: "string", minLength: 1, maxLength: 64, description: "Original persisted ordinary chat-post key. Only your own unexpired record is returned; no payload is required or verified." },
      }, required: ["c", "idempotency_key"], additionalProperties: false,
    },
  },
  parse: (i) => ({ c: channelParam(i), key: reqString(i, "idempotency_key", { max: 64 }) }),
  run: async (ctx, p) => {
    const v = viewerOf(ctx);
    const ch = await readableChannel(ctx, p.c);
    const r = (await conversationStub(ctx.env, ch.tenant_id, ch.project_id).postStatus(ch.tenant_id, ch.project_id, v.identity.id, p.key)) as PostStatus;
    const record = r.record;
    return {
      tenant_id: ch.tenant_id, conversation_id: ch.project_id, identity_id: v.identity.id, channel: ch.slug, ...r,
      text: plainText(`#${ch.slug} ordinary chat-post record head=${r.head}`, [
        record ? `recorded #${record.committed.seq} id=${record.committed.msg_id} committed_r=${record.committed.rev}; ${record.current ? `current_r=${record.current.rev}${record.current.retracted ? " retracted" : ""}` : "current message unavailable"}; expires_at=${record.expires_at}; intent_bound=${record.intent_bound}`
          : "No unexpired ordinary record. Expired, unkeyed and source-bound sends are not tracked here; absence does not prove nothing was sent.",
        "Posting evidence only, not payload verification, completion or execution authority. Reconcile authorized history and side effects before acting; do not blindly resend.",
      ]),
    };
  },
});
