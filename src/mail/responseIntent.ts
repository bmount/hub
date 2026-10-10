// Self-recorded human intention, NOT delivery, a scheduler, a grant or a reply promise.
import type { Ctx } from "../auth/context";
import { badRequest, conflict, notFound } from "../errors";
import { REPLY_WINDOW_MS } from "./limits";
import { sha256Hex, ulid } from "../ids";
import { REPLAY_PREFIX, type ReplayState } from "./replay";
import { decodeResponseRecipients, RESPONSE_RECIPIENT_PREFIX, recipientId } from "./responseRecipients";
import { resolveMailAddress } from "./projectMail";

export const RESPONSE_INTENT_PREFIX = "mail_response_intent:v1:";
// The public UTC minute format has a four-digit year; corrupt records cannot reach Date rendering.
const UTC_FORMAT_END = Date.UTC(10000, 0, 1);
type Intent = { revision: number; state: "planned" | "cancelled" | "completed"; updated_at: number; change_id: string; respond_by: number | null };
type Evidence = { id: string; tenant_id: string; project_id: string | null; identity_id: string;
  from_email: string; to_address: string; message_id: string; received_at: number };
function decode(raw: string | null): Intent | null {
  if (raw === null) return null;
  try {
    const s = JSON.parse(raw) as Intent;
    const due = s?.respond_by;
    const validDue = due === undefined || due === null || (s.state === "planned" && Number.isSafeInteger(due)
      && due > s.updated_at && due - s.updated_at <= REPLY_WINDOW_MS && due < UTC_FORMAT_END);
    return s && Number.isSafeInteger(s.revision) && s.revision > 0 && s.revision < Number.MAX_SAFE_INTEGER
      && ["planned", "cancelled", "completed"].includes(s.state) && Number.isSafeInteger(s.updated_at) && s.updated_at >= 0
      && recipientId(s.change_id) && validDue ? { ...s, respond_by: due ?? null } : null;
  } catch { return null; }
}
const keyFor = (ctx: Ctx, id: string) => `${RESPONSE_INTENT_PREFIX}${ctx.tenant!.id}:${id}:${ctx.identity!.id}`;
const valueAt = async (ctx: Ctx, key: string) => (await ctx.db.prepare("SELECT value FROM meta WHERE key = ?")
  .bind(key).first<{ value: string }>())?.value ?? null;

// Shared mail only, even for a human administrator/operator of a private agent.
// Current membership is mandatory; global root authority is not a response assignment.
const BASE = `m.id = ? AND m.tenant_id = ? AND m.recipient_id IS NULL
  AND m.verdict = 'admitted' AND m.reason IS NULL AND m.released_by IS NULL
  AND EXISTS (SELECT 1 FROM tenant t WHERE t.id = m.tenant_id AND t.state = 'active')
  AND EXISTS (SELECT 1 FROM identity i JOIN membership am ON am.identity_id = i.id
    WHERE i.id = ? AND i.kind = 'human' AND i.state = 'active'
      AND am.tenant_id = m.tenant_id AND am.state = 'active' AND am.role IN ('member', 'admin'))`;
async function evidence(ctx: Ctx, id: string) {
  const bindings = [id, ctx.tenant!.id, ctx.identity!.id];
  const row = await ctx.db.prepare(`SELECT m.id, m.tenant_id, m.project_id, m.identity_id,
    m.from_email, m.to_address, m.message_id, m.received_at FROM inbound_mail m WHERE ${BASE}`)
    .bind(...bindings).first<Evidence>();
  if (!row) throw notFound();
  const replayKey = REPLAY_PREFIX + row.tenant_id + ":" + await sha256Hex(JSON.stringify([row.from_email, row.to_address, row.message_id]));
  const replayRaw = await valueAt(ctx, replayKey);
  let replay: ReplayState | null = null;
  try { replay = replayRaw === null ? null : JSON.parse(replayRaw); } catch { /* fail closed */ }
  // Stored server-owned replay evidence, not caller proof or an admitted verdict alone.
  if (!replay || replay.status !== "stored" || replay.mail_id !== row.id || replay.identity_id !== row.identity_id
    || !recipientId(replay.attempt_id) || typeof replay.raw_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(replay.raw_sha256)
    || !Number.isSafeInteger(replay.reserved_at) || replay.reserved_at < 0) throw notFound();
  return { row, bindings, replayKey, replayRaw };
}
async function preference(ctx: Ctx, row: Evidence) {
  const target = await resolveMailAddress(ctx.db, ctx.env.HUB_DOMAIN, row.to_address);
  const key = `${RESPONSE_RECIPIENT_PREFIX}${row.tenant_id}:${row.project_id ?? "org"}`;
  const raw = await valueAt(ctx, key), config = decodeResponseRecipients(raw);
  const eligible = !!target && target.tenant_id === row.tenant_id && target.project_id === row.project_id
    && !target.recipient_id && !!config?.recipients.includes(ctx.identity!.id);
  return { key, raw, eligible };
}
type ReplyObservation = {
  state: "not_applicable" | "no_record" | "transport_accepted" | "consent_refused" | "outcome_unknown";
  outbound_id: string | null; recorded_at: number | null;
  recipient_delivery: "not_observed"; fulfillment: "not_inferred";
  coverage: "latest_recorded_matching_own_reply_since_revision_time";
};

/** Stored attempt evidence only. Absence/transport failure cannot prove that nothing was sent. */
async function replyObservation(ctx: Ctx, e: Awaited<ReturnType<typeof evidence>>, raw: string | null, intent: Intent | null): Promise<ReplyObservation> {
  const observation: ReplyObservation = { state: "not_applicable", outbound_id: null, recorded_at: null,
    recipient_delivery: "not_observed", fulfillment: "not_inferred",
    coverage: "latest_recorded_matching_own_reply_since_revision_time" };
  if (!intent || intent.state !== "planned") return observation;
  // Anchor the bounded latest-attempt query to current read authority and the exact
  // source/replay/intent snapshots. Do not expose an attempt after authority changes.
  const r = await ctx.db.prepare(`SELECT o.id, o.status, o.created_at FROM inbound_mail m
    LEFT JOIN outbound_mail o ON o.id = (SELECT attempt.id FROM outbound_mail attempt
      WHERE attempt.tenant_id = m.tenant_id AND attempt.in_reply_to = m.id AND attempt.sent_by = ?
        AND attempt.from_address = m.to_address AND attempt.to_address = m.from_email AND attempt.created_at >= ?
      ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT 1)
    WHERE ${BASE} AND m.project_id IS ? AND m.identity_id = ? AND m.from_email = ? AND m.to_address = ? AND m.message_id = ?
      AND EXISTS (SELECT 1 FROM meta WHERE key = ? AND value = ?)
      AND EXISTS (SELECT 1 FROM meta WHERE key = ? AND value = ?)`)
    .bind(ctx.identity!.id, intent.updated_at, ...e.bindings, e.row.project_id, e.row.identity_id,
      e.row.from_email, e.row.to_address, e.row.message_id, e.replayKey, e.replayRaw, keyFor(ctx, e.row.id), raw)
    .first<{ id: string | null; status: string | null; created_at: number | null }>();
  if (!r) throw conflict("response intention or reply evidence changed; read again");
  if (r.id === null) return { ...observation, state: "no_record" };
  if (!recipientId(r.id) || !Number.isSafeInteger(r.created_at) || r.created_at! < intent.updated_at
    || r.created_at! > ctx.now || r.created_at! >= UTC_FORMAT_END) return { ...observation, state: "outcome_unknown" };
  return { ...observation, outbound_id: r.id, recorded_at: r.created_at,
    state: r.status === "sent" ? "transport_accepted" : r.status === "refused" ? "consent_refused" : "outcome_unknown" };
}
export async function responseIntent(ctx: Ctx, id: string) {
  const e = await evidence(ctx, id), { row } = e;
  const raw = await valueAt(ctx, keyFor(ctx, id)), state = decode(raw), p = await preference(ctx, row);
  return { mail_id: id, revision: raw === null ? 0 : state?.revision ?? null,
    state: raw === null ? "unset" : !state ? "invalid" : state.state === "planned" && !p.eligible ? "stale"
      : state.state === "planned" && state.respond_by !== null && state.respond_by <= ctx.now ? "overdue" : state.state,
    updated_at: state?.updated_at ?? null, respond_by: state?.respond_by ?? null, can_plan: p.eligible,
    can_complete: state?.state === "planned", completion_evidence: state?.state === "completed" ? "self_reported" : "not_reported",
    recipient_delivery: "not_observed",
    reply_observation: await replyObservation(ctx, e, raw, state),
    automatic_execution: "not_implemented", notification: "not_requested", response_guaranteed: false };
}
export async function setResponseIntent(ctx: Ctx, id: string, state: Intent["state"], expected: number, respondBy: number | null = null) {
  if (respondBy !== null && (state !== "planned" || !Number.isSafeInteger(respondBy) || respondBy <= ctx.now
    || respondBy - ctx.now > REPLY_WINDOW_MS || respondBy >= UTC_FORMAT_END)) {
    throw badRequest("respond-by must be a future UTC time within the reply window, for a planned intention only");
  }
  const e = await evidence(ctx, id), key = keyFor(ctx, id), raw = await valueAt(ctx, key), old = decode(raw);
  if (respondBy !== null && (!Number.isSafeInteger(e.row.received_at) || e.row.received_at < 0
    || e.row.received_at > ctx.now || respondBy > e.row.received_at + REPLY_WINDOW_MS)) {
    throw conflict("respond-by must be within 30 days of receiving this message");
  }
  if (raw !== null && !old) throw conflict("invalid response intent requires reconciliation");
  if ((old?.revision ?? 0) !== expected) throw conflict("response intent changed; read before editing");
  if ((state === old?.state && respondBy === old.respond_by) || (state === "cancelled" && !old)) throw conflict("no response intent transition");
  // Only an explicit assertion by the owner of an outstanding plan can complete it.
  // Terminal states cannot be completed/cancelled again; replan is a separate CAS.
  if ((state === "completed" || state === "cancelled") && old?.state !== "planned") {
    throw conflict("completion or cancellation requires an outstanding own intention");
  }
  const p = await preference(ctx, e.row);
  if (state === "planned" && !p.eligible) throw conflict("current mailbox preferences do not select you");
  const next: Intent = { revision: expected + 1, state, updated_at: ctx.now, change_id: ulid(ctx.now), respond_by: respondBy };
  const value = JSON.stringify(next);
  const r = await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO meta (key, value) SELECT ?, ? FROM inbound_mail m
      WHERE ${BASE} AND m.project_id IS ? AND m.identity_id = ? AND m.from_email = ? AND m.to_address = ? AND m.message_id = ?
        AND EXISTS (SELECT 1 FROM meta r WHERE r.key = ? AND r.value = ?)
        AND (? IS NULL OR m.received_at = ? AND m.received_at <= ? AND ? <= m.received_at + ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM meta previous WHERE previous.key = ? AND previous.value = ?))
        AND (? IN ('cancelled', 'completed') OR (
          EXISTS (SELECT 1 FROM meta c WHERE c.key = ? AND c.value = ?)
          AND (m.project_id IS NULL AND EXISTS (SELECT 1 FROM tenant t WHERE t.id = m.tenant_id AND m.to_address = t.slug || '@' || ?)
            OR EXISTS (SELECT 1 FROM project pr JOIN tenant t ON t.id = pr.tenant_id
              WHERE pr.id = m.project_id AND pr.tenant_id = m.tenant_id AND pr.state = 'active' AND pr.kind <> 'channel'
                AND m.to_address = t.slug || '.' || pr.slug || '@' || ?))))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value = ?`)
      .bind(key, value, ...e.bindings, e.row.project_id, e.row.identity_id, e.row.from_email, e.row.to_address, e.row.message_id,
        e.replayKey, e.replayRaw, respondBy, e.row.received_at, ctx.now, respondBy, REPLY_WINDOW_MS,
        raw, key, raw, state, p.key, p.raw, ctx.env.HUB_DOMAIN.toLowerCase(), ctx.env.HUB_DOMAIN.toLowerCase(), raw),
    ctx.db.prepare(`INSERT INTO event (id, tenant_id, identity_id, session_id, kind, target_kind, target_id, summary, created_at)
      SELECT ?, ?, ?, ?, 'mail.set_response_intent', 'inbound_mail', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM meta WHERE key = ? AND value = ?)`)
      .bind(ulid(ctx.now), ctx.tenant!.id, ctx.identity!.id, ctx.session?.id ?? null, id,
        state === "planned" ? "Recorded own human response intention (no delivery or execution requested)"
          : state === "completed" ? "Self-reported completion of own human response intention (recipient delivery not observed)"
          : "Cancelled own human response intention",
        ctx.now, key, value),
  ]);
  if (r[0]!.meta.changes !== 1) throw conflict("response intent or eligibility changed; read before editing");
  return { revision: next.revision, state, respond_by: respondBy,
    completion_evidence: state === "completed" ? "self_reported" : "not_reported", recipient_delivery: "not_observed",
    automatic_execution: "not_implemented", notification: "not_requested", response_guaranteed: false };
}
