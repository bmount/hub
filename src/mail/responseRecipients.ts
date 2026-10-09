// Preferences only: never an access grant, notification, wake or response promise.
import { conflict, notFound } from "../errors";
import { ulid } from "../ids";
import type { Ctx } from "../auth/context";
import { resolveMailAddress, type MailTarget } from "./projectMail";

export const RESPONSE_RECIPIENT_PREFIX = "mail_response_recipients:v1:";
export const MAX_RESPONSE_RECIPIENTS = 10;
export const recipientId = (id: unknown): id is string => typeof id === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
type Config = { revision: number; recipients: string[]; updated_at: number; change_id: string };
const keyFor = (t: MailTarget) => `${RESPONSE_RECIPIENT_PREFIX}${t.tenant_id}:${t.project_id ?? "org"}`;

async function targetFor(ctx: Ctx, address: string) {
  const target = await resolveMailAddress(ctx.db, ctx.env.HUB_DOMAIN, address);
  // Direct-agent mail already has its own recipient and private access boundary.
  if (!target || target.tenant_id !== ctx.tenant!.id || target.recipient_id) throw notFound();
  return target;
}
function decode(raw: string | null): Config | null {
  if (raw === null) return null;
  try {
    const c = JSON.parse(raw) as Config;
    if (!c || !Number.isSafeInteger(c.revision) || c.revision < 1 || c.revision >= Number.MAX_SAFE_INTEGER
      || !Number.isSafeInteger(c.updated_at) || c.updated_at < 0 || !recipientId(c.change_id)
      || !Array.isArray(c.recipients) || c.recipients.length > MAX_RESPONSE_RECIPIENTS
      || !c.recipients.every(recipientId) || new Set(c.recipients).size !== c.recipients.length) return null;
    return c;
  } catch { return null; }
}
async function eligible(ctx: Ctx, ids: string[]) {
  return (await ctx.db.prepare(`SELECT i.id FROM identity i JOIN membership m ON m.identity_id = i.id
    WHERE m.tenant_id = ? AND m.state = 'active' AND m.role IN ('member', 'admin')
      AND i.kind = 'human' AND i.state = 'active' AND i.id IN (SELECT value FROM json_each(?))`)
    .bind(ctx.tenant!.id, JSON.stringify(ids)).all<{ id: string }>()).results.map(r => r.id);
}
export async function responseRecipients(ctx: Ctx, address: string) {
  const target = await targetFor(ctx, address);
  const raw = (await ctx.db.prepare("SELECT value FROM meta WHERE key = ?").bind(keyFor(target)).first<{ value: string }>())?.value ?? null;
  const config = decode(raw);
  const current = config ? new Set(await eligible(ctx, config.recipients)) : new Set<string>();
  return {
    address: address.trim().toLowerCase(), project_id: target.project_id,
    revision: raw === null ? 0 : config?.revision ?? null,
    state: raw === null ? "unset" : !config ? "invalid" : !config.recipients.length ? "empty"
      : current.size !== config.recipients.length ? "stale" : "configured",
    // Do not expose removed/foreign identities from stale or corrupted preferences.
    recipients: config?.recipients.filter(id => current.has(id)) ?? [],
    unavailable_count: config ? config.recipients.length - current.size : null,
    updated_at: config?.updated_at ?? null,
    automatic_scheduling: "not_implemented", response_guaranteed: false,
  };
}

export async function setResponseRecipients(ctx: Ctx, address: string, recipients: string[], expected: number) {
  const target = await targetFor(ctx, address), key = keyFor(target);
  const raw = (await ctx.db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
  const old = decode(raw);
  if (raw !== null && !old) throw conflict("invalid recipient configuration requires administrator reconciliation");
  if ((old?.revision ?? 0) !== expected) throw conflict("recipient configuration changed; read before editing");
  if ((await eligible(ctx, recipients)).length !== recipients.length) throw conflict("recipients must be active human members of this organization");
  const next: Config = { revision: expected + 1, recipients, updated_at: ctx.now, change_id: ulid(ctx.now) };
  const value = JSON.stringify(next);
  // Repeat eligibility inside the atomic CAS; archiving/removal cannot become a grant.
  // Audit commits in the same transaction only for this unique successful change.
  const result = await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO meta (key, value) SELECT ?, ? FROM tenant t
      WHERE t.id = ? AND t.state = 'active'
        AND EXISTS (SELECT 1 FROM identity actor WHERE actor.id = ? AND actor.kind = 'human' AND actor.state = 'active'
          AND (actor.is_root = 1 OR EXISTS (SELECT 1 FROM membership am WHERE am.identity_id = actor.id
            AND am.tenant_id = t.id AND am.state = 'active' AND am.role = 'admin')))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM project p WHERE p.id = ? AND p.tenant_id = t.id AND p.state = 'active' AND p.kind <> 'channel'))
        AND (SELECT COUNT(*) FROM identity i JOIN membership m ON m.identity_id = i.id
          WHERE m.tenant_id = t.id AND m.state = 'active' AND m.role IN ('member', 'admin')
            AND i.kind = 'human' AND i.state = 'active' AND i.id IN (SELECT value FROM json_each(?))) = ?
      ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value = ?`)
      .bind(key, value, target.tenant_id, ctx.identity!.id, target.project_id, target.project_id, JSON.stringify(recipients), recipients.length, raw),
    ctx.db.prepare(`INSERT INTO event (id, tenant_id, identity_id, session_id, kind, target_kind, target_id, summary, created_at)
      SELECT ?, ?, ?, ?, 'mail.set_response_recipients', 'mailbox', ?, 'Updated response-recipient preferences (no response scheduled)', ?
      WHERE EXISTS (SELECT 1 FROM meta WHERE key = ? AND value = ?)`)
      .bind(ulid(ctx.now), target.tenant_id, ctx.identity!.id, ctx.session?.id ?? null, target.project_id ?? target.tenant_id, ctx.now, key, value),
  ]);
  if (result[0]!.meta.changes !== 1) throw conflict("recipient configuration or eligibility changed; read before editing");
  return { revision: next.revision, automatic_scheduling: "not_implemented", response_guaranteed: false };
}
