import { defineVerb } from "./table";
import { bodyParam, channelParam, msgParam, refsParam } from "./chatParams";
import { badRequest } from "../errors";
import { LIMITS } from "../chat/rules";
import { postIntentFingerprint } from "../chat/postIntent";
import { reqString } from "./params";
import { readableChannel, viewerOf } from "../chat/access";
import { chatText, plainText } from "../chat/compact";
import { conversationStub } from "../chat/stubs";
import type { PostStatus } from "../chat/types";

export const chatPostStatus = defineVerb({
  name: "chat.post_status", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Reconcile your own ordinary chat-post key without sending or guessing its payload. Only unexpired 24-hour records are returned; missing records do not prove nothing was sent. Source-bound replies use chat_response_status instead. Optionally compare a preserved intent with the original commit, not current text. This is posting evidence, not execution authority or permission to resend.",
  mcp: {
    scope: "read", destructive: false, title: "Reconcile an ordinary chat post", render: chatText, auditKeysOnly: true,
    input: {
      type: "object", properties: {
        c: { type: "string", description: "Authorized channel name." },
        idempotency_key: { type: "string", minLength: 1, maxLength: 64, description: "Original persisted ordinary chat-post key. Only your own unexpired record is returned; no payload is required." },
        intent: {
          type: "object", additionalProperties: false, required: ["body"],
          description: "Optional exact preserved ordinary intent to compare without sending. Missing or unbound records cannot verify it; equality is not permission to resend.",
          properties: {
            body: { type: "string", maxLength: LIMITS.BODY_MAX, description: "Original body, nonblank and at most 8 KiB." },
            reply_to: { type: ["integer", "string", "null"], description: "Original reply target alias before resolution, or omit for top-level. Changing an id to its number is a different intent." },
            refs: { type: "array", maxItems: LIMITS.REFS_MAX, items: { type: "object", additionalProperties: false, required: ["kind", "key"], properties: { kind: { type: "string", maxLength: 16 }, key: { type: "string", maxLength: 128 } } }, description: "Original ordered explicit refs before resolution; omission means empty." },
          },
        },
      }, required: ["c", "idempotency_key"], additionalProperties: false,
    },
  },
  parse: (i) => {
    let intent;
    if (i.intent !== undefined) {
      if (!i.intent || typeof i.intent !== "object" || Array.isArray(i.intent)) throw badRequest("intent must be {body, reply_to?, refs?}");
      const input = i.intent as Record<string, unknown>;
      if (Object.keys(input).some((k) => !["body", "reply_to", "refs"].includes(k))) throw badRequest("intent accepts only body, reply_to and refs; no supplied digest");
      intent = { body: bodyParam(input), reply_to: msgParam(input, "reply_to", false), refs: refsParam(input) };
    }
    return { c: channelParam(i), key: reqString(i, "idempotency_key", { max: 64 }), intent };
  },
  run: async (ctx, p) => {
    const v = viewerOf(ctx);
    const ch = await readableChannel(ctx, p.c);
    const fingerprint = p.intent ? await postIntentFingerprint(p.intent) : undefined;
    const r = (await conversationStub(ctx.env, ch.tenant_id, ch.project_id).postStatus(ch.tenant_id, ch.project_id, v.identity.id, p.key, fingerprint)) as PostStatus;
    const record = r.record;
    return {
      tenant_id: ch.tenant_id, conversation_id: ch.project_id, identity_id: v.identity.id, channel: ch.slug, ...r,
      text: plainText(`#${ch.slug} ordinary chat-post record head=${r.head}`, [
        record ? `recorded #${record.committed.seq} id=${record.committed.msg_id} committed_r=${record.committed.rev}; ${record.current ? `current_r=${record.current.rev}${record.current.retracted ? " retracted" : ""}` : "current message unavailable"}; expires_at=${record.expires_at}; intent_bound=${record.intent_bound}`
          : "No unexpired ordinary record. Expired, unkeyed and source-bound sends are not tracked here; absence does not prove nothing was sent.",
        ...(r.intent_check ? [`intent comparison: ${r.intent_check.reason}; ${r.intent_check.matches === null ? "original intent cannot be verified" : r.intent_check.matches ? "matches original commit" : "differs from original commit"}; not current-text validation and not permission to resend`] : []),
        `${r.intent_check ? "Original-intent evidence only, not current-text validation" : "Posting evidence only, not payload verification"}, completion or execution authority. Reconcile authorized history and side effects before acting; do not blindly resend.`,
      ]),
    };
  },
});
