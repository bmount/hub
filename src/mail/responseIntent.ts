// Self-recorded human intention, NOT delivery, a scheduler, a grant or a reply promise.
import type { Ctx } from "../auth/context";
import { conflict, notFound } from "../errors";
import { sha256Hex, ulid } from "../ids";
import { REPLAY_PREFIX, type ReplayState } from "./replay";
import { decodeResponseRecipients, RESPONSE_RECIPIENT_PREFIX, recipientId } from "./responseRecipients";
import { resolveMailAddress } from "./projectMail";

export const RESPONSE_INTENT_PREFIX = "mail_response_intent:v1:";
type Intent = { revision: number; state: "planned" | "cancelled"; updated_at: number; change_id: string };
type Evidence = { id: string; tenant_id: string; project_id: string | null; identity_id: string;
  from_email: string; to_address: string; message_id: string };
function decode(raw: string | null): Intent | null {
  if (raw === null) return null;
  try {
    const s = JSON.parse(raw) as Intent;
    return s && Number.isSafeInteger(s.revision) && s.revision > 0 && s.revision < Number.MAX_SAFE_INTEGER
      && ["planned", "cancelled"].includes(s.state) && Number.isSafeInteger(s.updated_at) && s.updated_at >= 0
      && recipientId(s.change_id) ? s : null;
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
    m.from_email, m.to_address, m.message_id FROM inbound_mail m WHERE ${BASE}`)
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
export async function responseIntent(ctx: Ctx, id: string) {
  const { row } = await evidence(ctx, id);
  const raw = await valueAt(ctx, keyFor(ctx, id)), state = decode(raw), p = await preference(ctx, row);
  return { mail_id: id, revision: raw === null ? 0 : state?.revision ?? null,
    state: raw === null ? "unset" : !state ? "invalid" : state.state === "planned" && !p.eligible ? "stale" : state.state,
    updated_at: state?.updated_at ?? null, can_plan: p.eligible,
    automatic_execution: "not_implemented", notification: "not_requested", response_guaranteed: false };
}
export async function setResponseIntent(ctx: Ctx, id: string, state: Intent["state"], expected: number) {
  const e = await evidence(ctx, id), key = keyFor(ctx, id), raw = await valueAt(ctx, key), old = decode(raw);
  if (raw !== null && !old) throw conflict("invalid response intent requires reconciliation");
  if ((old?.revision ?? 0) !== expected) throw conflict("response intent changed; read before editing");
  if (state === old?.state || (state === "cancelled" && !old)) throw conflict("no response intent transition");
  const p = await preference(ctx, e.row);
  if (state === "planned" && !p.eligible) throw conflict("current mailbox preferences do not select you");
  const next: Intent = { revision: expected + 1, state, updated_at: ctx.now, change_id: ulid(ctx.now) };
  const value = JSON.stringify(next);
  const r = await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO meta (key, value) SELECT ?, ? FROM inbound_mail m
      WHERE ${BASE} AND m.project_id IS ? AND m.identity_id = ? AND m.from_email = ? AND m.to_address = ? AND m.message_id = ?
        AND EXISTS (SELECT 1 FROM meta r WHERE r.key = ? AND r.value = ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM meta previous WHERE previous.key = ? AND previous.value = ?))
        AND (? = 'cancelled' OR (
          EXISTS (SELECT 1 FROM meta c WHERE c.key = ? AND c.value = ?)
          AND (m.project_id IS NULL AND EXISTS (SELECT 1 FROM tenant t WHERE t.id = m.tenant_id AND m.to_address = t.slug || '@' || ?)
            OR EXISTS (SELECT 1 FROM project pr JOIN tenant t ON t.id = pr.tenant_id
              WHERE pr.id = m.project_id AND pr.tenant_id = m.tenant_id AND pr.state = 'active' AND pr.kind <> 'channel'
                AND m.to_address = t.slug || '.' || pr.slug || '@' || ?))))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value = ?`)
      .bind(key, value, ...e.bindings, e.row.project_id, e.row.identity_id, e.row.from_email, e.row.to_address, e.row.message_id,
        e.replayKey, e.replayRaw, raw, key, raw, state, p.key, p.raw, ctx.env.HUB_DOMAIN.toLowerCase(), ctx.env.HUB_DOMAIN.toLowerCase(), raw),
    ctx.db.prepare(`INSERT INTO event (id, tenant_id, identity_id, session_id, kind, target_kind, target_id, summary, created_at)
      SELECT ?, ?, ?, ?, 'mail.set_response_intent', 'inbound_mail', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM meta WHERE key = ? AND value = ?)`)
      .bind(ulid(ctx.now), ctx.tenant!.id, ctx.identity!.id, ctx.session?.id ?? null, id,
        state === "planned" ? "Recorded own human response intention (no delivery or execution requested)" : "Cancelled own human response intention",
        ctx.now, key, value),
  ]);
  if (r[0]!.meta.changes !== 1) throw conflict("response intent or eligibility changed; read before editing");
  return { revision: next.revision, state, automatic_execution: "not_implemented", notification: "not_requested", response_guaranteed: false };
}
