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

export function retainedPresence(rows: PresenceRow[], now: number): PresenceRow[] {
  // A clock rollback cannot turn an observation from the future into current
  // activity (or a reported offline fact). Omit it as unknown before the cap;
  // reads never rewrite stored reports or manufacture replacement timestamps.
  return rows.filter((r) => r.last_seen <= now && r.last_seen > now - PRESENCE_RETENTION_MS).sort((a, b) => b.last_seen - a.last_seen).slice(0, PRESENCE_MAX);
}
