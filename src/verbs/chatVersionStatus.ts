import { defineVerb } from "./table";
import { channelParam } from "./chatParams";
import { reqEnum, reqString } from "./params";
import { readableChannel, viewerOf } from "../chat/access";
import { chatText, plainText } from "../chat/compact";
import { conversationStub } from "../chat/stubs";
import type { VersionStatus } from "../chat/types";

/** Reconcile an ambiguous version write without resending or inspecting a guessed payload. */
export const chatVersionStatus = defineVerb({
  name: "chat.version_status", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Reconcile your own chat edit/retraction key without replaying a write. Only unexpired 24-hour records are returned; absence does not prove nothing changed. Separates original commitment from current message state. Not payload verification, execution authority or permission to retry; reconcile authorized revision history and side effects.",
  mcp: {
    scope: "read", destructive: false, title: "Reconcile a chat edit or retraction", render: chatText, auditKeysOnly: true,
    input: {
      type: "object", properties: {
        c: { type: "string", description: "Authorized channel name." },
        operation: { type: "string", enum: ["edit", "retract"], description: "Original write operation. Post keys and the other version operation are separate namespaces." },
        idempotency_key: { type: "string", minLength: 1, maxLength: 64, description: "Exact original persisted version-write key. Only your own unexpired record is returned; no payload is required." },
      }, required: ["c", "operation", "idempotency_key"], additionalProperties: false,
    },
  },
  parse: (i) => ({ c: channelParam(i), operation: reqEnum(i, "operation", ["edit", "retract"] as const), key: reqString(i, "idempotency_key", { max: 64 }) }),
  run: async (ctx, p) => {
    const v = viewerOf(ctx);
    const ch = await readableChannel(ctx, p.c);
    const r = (await conversationStub(ctx.env, ch.tenant_id, ch.project_id).versionStatus(ch.tenant_id, ch.project_id, v.identity.id, p.operation, p.key)) as VersionStatus;
    const record = r.record;
    return {
      tenant_id: ch.tenant_id, conversation_id: ch.project_id, identity_id: v.identity.id, channel: ch.slug, ...r,
      text: plainText(`#${ch.slug} chat-${r.operation} record head=${r.head}`, [
        record ? `recorded activity_seq=${record.committed.seq} id=${record.committed.msg_id} committed_r=${record.committed.rev}; ${record.current ? `current_r=${record.current.rev}${record.current.retracted ? " retracted" : ""}` : "current message unavailable"}; expires_at=${record.expires_at}; intent_bound=${record.intent_bound}`
          : "No unexpired record for this operation. Expired and unkeyed changes are not tracked here; absence does not prove nothing changed.",
        "Commitment evidence only, not payload verification, execution authority or permission to retry. Read authorized revision history and reconcile side effects; do not blindly repeat the write.",
      ]),
    };
  },
});
