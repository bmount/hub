/** Explicit channel heartbeats, not evidence of a person reading or an agent doing work. */
export const PRESENCE_TTL_MS = 90_000;
export const PRESENCE_RETENTION_MS = 24 * 60 * 60_000;
export const PRESENCE_MAX = 200;
export type PresenceStatus = "online" | "away" | "offline";
export type PresenceRow = { identity_id: string; status: PresenceStatus; last_seen: number; expires_at: number; via_assistant?: boolean };
export type PresenceState = PresenceStatus | "stale";

export function presenceState(row: PresenceRow, now: number): PresenceState {
  if (row.status === "offline") return "offline";
  return now < row.expires_at ? row.status : "stale";
}

function validPresenceRow(value: unknown): value is PresenceRow {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<PresenceRow>;
  const timestamp = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
  if (typeof r.identity_id !== "string" || !r.identity_id ||
      !["online", "away", "offline"].includes(r.status ?? "") ||
      !timestamp(r.last_seen) || !timestamp(r.expires_at) ||
      (r.via_assistant !== undefined && typeof r.via_assistant !== "boolean")) return false;
  const ttl = r.expires_at - r.last_seen;
  // Offline has no online lease. Shorter legacy leases remain valid; never
  // normalize an invalid lease into a fresh status or coerce assistant evidence.
  return r.status === "offline" ? ttl === 0 : ttl > 0 && ttl <= PRESENCE_TTL_MS;
}

export function retainedPresence(rows: unknown, now: number): PresenceRow[] {
  if (!Array.isArray(rows)) return [];
  // Validate persisted state before sorting/capping: one unusable row must not
  // poison valid peers or claim an unbounded lease. Reads omit as unknown only.
  // A clock rollback cannot turn a future observation into current activity.
  return rows.filter(validPresenceRow).filter((r) => r.last_seen <= now && r.last_seen > now - PRESENCE_RETENTION_MS)
    .sort((a, b) => b.last_seen - a.last_seen).slice(0, PRESENCE_MAX);
}
