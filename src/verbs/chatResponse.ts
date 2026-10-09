import { defineVerb } from "./table";
import { bodyParam, channelParam, msgParam, refsParam, responseParam } from "./chatParams";
import { badRequest, notFound } from "../errors";
import { LIMITS } from "../chat/rules";
import { responseIntent } from "../chat/responseIntent";
import { readableChannel, viewerOf } from "../chat/access";
import { chatText, plainText } from "../chat/compact";
import { conversationStub } from "../chat/stubs";
import type { ResponseSlot, ResponseStatus } from "../chat/types";

/** Compact reconciliation evidence, not a permission gate or a task state machine. */
export const chatResponseStatus = defineVerb({
  name: "chat.response_status", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Look up your own durable progress/result chat posts for one source message without sending anything. Optionally compare a persisted posting intent with the original record, not current source evidence. Records prove only chat posting, not task completion or permission to resend. Missing slots do not rule out ordinary replies; reconcile the original thread before acting.",
  mcp: {
    scope: "read", destructive: false, title: "Reconcile recorded chat responses", render: chatText, auditKeysOnly: true,
    input: {
      type: "object", properties: {
        c: { type: "string", description: "Authorized channel name." },
        msg: { type: ["integer", "string"], description: "Original source message number or exact msg_id. Only the authenticated caller's response slots are returned." },
        intent: {
          type: "object", additionalProperties: false, required: ["body", "response_to"],
          description: "Optional exact persisted parsed intent to compare, without sending. Equality is with the original commit, not current text or execution status. Missing slots return matches:null, not permission to resend.",
          properties: {
            body: { type: "string", maxLength: LIMITS.BODY_MAX, description: "Original posted body, at most 8 KiB." },
            refs: { type: "array", maxItems: LIMITS.REFS_MAX, items: { type: "object", additionalProperties: false, required: ["kind", "key"], properties: { kind: { type: "string", maxLength: 16 }, key: { type: "string", maxLength: 128 } } }, description: "Original ordered explicit refs before resolution; omission means empty." },
            response_to: { type: "object", additionalProperties: false, required: ["msg_id", "rev", "author_id"], properties: {
              msg_id: { type: "string" }, rev: { type: "integer", minimum: 1, maximum: LIMITS.VERSIONS_MAX }, author_id: { type: "string" }, stage: { type: "string", enum: ["progress", "result"], description: "Slot to compare; omission means result." },
            } },
          },
        },
      }, required: ["c", "msg"], additionalProperties: false,
    },
  },
  parse: (i) => {
    let intent;
    if (i.intent !== undefined) {
      if (!i.intent || typeof i.intent !== "object" || Array.isArray(i.intent)) throw badRequest("intent must be {body, refs?, response_to}");
      const input = i.intent as Record<string, unknown>;
      if (Object.keys(input).some((k) => !["body", "refs", "response_to"].includes(k))) throw badRequest("intent accepts only body, refs and response_to; no supplied digest");
      const target = responseParam(input);
      if (!target) throw badRequest("intent.response_to is required");
      intent = { body: bodyParam(input), refs: refsParam(input), target };
    }
    return { c: channelParam(i), msg: msgParam(i, "msg", true), intent };
  },
  run: async (ctx, p) => {
    const v = viewerOf(ctx);
    const ch = await readableChannel(ctx, p.c);
    const intent = p.intent ? await responseIntent(p.intent.body, p.intent.refs, p.intent.target) : undefined;
    const r = (await conversationStub(ctx.env, ch.tenant_id, ch.project_id).responseStatus(ch.tenant_id, ch.project_id, v.identity.id, p.msg, intent)) as ResponseStatus | null;
    if (!r) throw notFound("no such source message");
    const line = (stage: string, slot: ResponseSlot | null) => !slot
      ? `${stage}: no durable record (ordinary replies are not tracked here)`
      : `${stage}: recorded #${slot.committed.seq} id=${slot.committed.msg_id} committed_r=${slot.committed.rev}; source_r=${slot.source.rev} author_id=${slot.source.author_id}; ${slot.current ? `current_r=${slot.current.rev}${slot.current.retracted ? " retracted" : ""}` : "current message unavailable"}`;
    return {
      tenant_id: ch.tenant_id, conversation_id: ch.project_id, identity_id: v.identity.id, channel: ch.slug, ...r,
      text: plainText(`#${ch.slug} recorded chat responses head=${r.head}`, [
        `source #${r.source.seq} id=${r.source.msg_id} current_r=${r.source.rev} author_id=${r.source.author_id}${r.source.retracted ? " retracted" : ""}`,
        line("progress", r.progress), line("result", r.result),
        ...(r.intent_check ? [`${r.intent_check.stage} intent comparison: ${r.intent_check.matches === null ? "no durable slot" : r.intent_check.matches ? "matches original commit" : "differs from original commit"}; not current-source validation or permission to resend`] : []),
        "Records are chat-post evidence only, not task completion or execution authority. Read the original thread and recheck delegated scope before acting.",
      ]),
    };
  },
});
