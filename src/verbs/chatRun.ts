import { defineVerb } from "./table";
import { reqString } from "./params";
import { channelParam, msgParam, responseParam } from "./chatParams";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { readableChannel, viewerOf } from "../chat/access";
import { conversationStub } from "../chat/stubs";
import { getControls } from "../db/chat";
import { sha256Hex } from "../ids";
import { chatText, plainText } from "../chat/compact";
import { LIMITS } from "../chat/rules";
import type { RunClaimOutcome, RunStatus } from "../chat/runClaim";
import type { Ctx } from "../auth/context";

function agent(ctx: Ctx) {
  const v = viewerOf(ctx);
  if (v.identity.kind !== "agent" || v.session?.kind !== "agent_run") throw forbidden("run reservations are only for authenticated agent run sessions");
  return v;
}

function result(ctx: Ctx, channel: { tenant_id: string; project_id: string; slug: string }, r: RunStatus & { acquired?: boolean }) {
  return {
    tenant_id: channel.tenant_id, conversation_id: channel.project_id, identity_id: ctx.identity!.id, channel: channel.slug, ...r,
    text: plainText(`#${channel.slug} run reservation`, [
      r.claim ? `reserved source_r=${r.claim.source.rev}; authority=conversation_only` : "no run reservation; reconcile original thread and prior effects before adoption",
      ...(r.acquired === undefined ? [] : [r.acquired ? "new reservation; not proof a model started" : "already reserved; do not start another model turn"]),
      "Reservation is not execution authority, live presence, task completion or permission to replay an ambiguous model start.",
    ]),
  };
}

export const chatRunClaim = defineVerb({
  name: "chat.run_claim", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Reserve one model run for a current native human message explicitly mentioning this agent. Persist exact source evidence and run_key before calling. Only the first reservation returns acquired:true; retries never authorize another model start. Conversation-only authority: no inherited operator shell, release or administrative permissions. Reconcile prior thread/side effects before adoption.",
  mcp: {
    scope: "write", destructive: false, title: "Reserve a chat run", render: chatText, auditKeysOnly: true,
    input: { type: "object", additionalProperties: false, required: ["c", "source", "run_key"], properties: {
      c: { type: "string" },
      source: { type: "object", additionalProperties: false, required: ["msg_id", "rev", "author_id"], properties: {
        msg_id: { type: "string" }, author_id: { type: "string" }, rev: { type: "integer", minimum: 1, maximum: LIMITS.VERSIONS_MAX },
      } },
      run_key: { type: "string", minLength: 1, maxLength: 64, description: "Persist a stable opaque key, not credentials or transcript text. Replay returns acquired:false, including after a restart; never blindly start again." },
    } },
  },
  parse: (i) => {
    if (!i.source || typeof i.source !== "object" || Array.isArray(i.source) || Object.keys(i.source).some((k) => !["msg_id", "rev", "author_id"].includes(k))) throw badRequest("source requires exact msg_id, rev and author_id");
    const source = responseParam({ response_to: i.source })!;
    const run_key = reqString(i, "run_key", { max: 64 });
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(run_key)) throw badRequest("run_key must be an opaque identifier of 1–64 letters, digits, underscores or hyphens");
    return { c: channelParam(i), source, run_key };
  },
  run: async (ctx, p) => {
    const v = agent(ctx);
    const ch = await readableChannel(ctx, p.c);
    if (ch.state !== "active") throw conflict("channel is archived");
    const controls = await getControls(ctx.db, ch.tenant_id, ctx.now);
    if (!controls.agents_enabled || controls.muted.includes(v.identity.id) || ch.agent_policy === "muted") throw forbidden("agent runs are disabled or muted here");
    const author = await ctx.db.prepare("SELECT 1 FROM identity i JOIN membership m ON m.identity_id = i.id WHERE i.id = ? AND i.kind = 'human' AND i.state = 'active' AND m.tenant_id = ? AND m.state = 'active'")
      .bind(p.source.author_id, ch.tenant_id).first();
    // Recorded authorship survives offboarding, but must not create new conversational work for an inactive member.
    if (!author) throw forbidden("source author is not an active human member of this tenant");
    const fingerprint = await sha256Hex(p.run_key);
    const r = await conversationStub(ctx.env, ch.tenant_id, ch.project_id).claimRun(ch.tenant_id, ch.project_id, v.identity.id, p.source, fingerprint, ctx.now) as RunClaimOutcome;
    if ("refused" in r) {
      if (r.refused === "not_found") throw notFound(r.detail);
      if (r.refused === "forbidden") throw forbidden(r.detail);
      throw conflict(r.detail);
    }
    return result(ctx, ch, r);
  },
});

export const chatRunStatus = defineVerb({
  name: "chat.run_status", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Read this agent's durable run reservation and compare its source with current evidence, without starting, sending or acknowledging anything. Missing is not proof no model ran; reserved is not proof of execution, presence or completion.",
  mcp: { scope: "read", destructive: false, title: "Reconcile a chat run reservation", render: chatText, auditKeysOnly: true,
    input: { type: "object", additionalProperties: false, required: ["c", "msg"], properties: { c: { type: "string" }, msg: { type: ["integer", "string"] } } },
  },
  parse: (i) => ({ c: channelParam(i), msg: msgParam(i, "msg", true) }),
  run: async (ctx, p) => {
    const v = agent(ctx);
    const ch = await readableChannel(ctx, p.c);
    const r = await conversationStub(ctx.env, ch.tenant_id, ch.project_id).runStatus(ch.tenant_id, ch.project_id, v.identity.id, p.msg) as RunStatus | null;
    if (!r) throw notFound("no such source message");
    return result(ctx, ch, r);
  },
});
