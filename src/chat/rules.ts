import type { AuthorKind } from "./types";

/** Messaging spec 6.5, 6.6, 12. */
export const LIMITS = {
  BODY_MAX: 8192,
  REFS_MAX: 20,
  WAKING_MENTIONS_MAX: 10,
  VERSIONS_MAX: 50,
  HOP_LIMIT: 3,
  HUMAN_GATE: 8,
  PAIR_ALTERNATIONS: 4,
  PAIR_WINDOW_MS: 10 * 60_000,
  PAIR_BLOCK_MS: 30 * 60_000,
  DUPLICATE_WINDOW_MS: 10 * 60_000,
  CONV_AGENT_PER_MIN: 30,
  SESSION_PER_MIN: 6,
  SESSION_PER_HOUR: 60,
  AGENT_PER_DAY: 300,
  HUMAN_PER_MIN: 30,
  TRIPWIRE_REFUSALS: 20,
  INBOX_WAIT_MAX_S: 20,
  INBOX_WAITERS_MAX: 8,
  /** A wake delivered this recently is the cause of an agent's next post, acked or not (ruling C-4). */
  WAKE_HOP_WINDOW_MS: 10 * 60_000,
  INBOX_LIMIT_MAX: 100,
  INBOX_ACKED_KEEP_MS: 30 * 86_400_000,
  IDEM_TTL_MS: 86_400_000,
  OUTBOX_BACKOFF_BASE_MS: 5_000,
  OUTBOX_BACKOFF_MAX_MS: 600_000,
  OUTBOX_MAX_ATTEMPTS: 20,
  BUDGET_DEFAULT: 1500,
  BUDGET_MAX: 8000,
} as const;

/**
 * Human 0; agent 1 + the higher of the replied-to message's hop and the hop of the newest open wake in the scope
 * (ruling C-4), so replying to a human root cannot reset a chain. No cause at all counts as hop 0.
 */
export function computeHop(kind: AuthorKind, targetHop: number | null, wakeHop: number | null = null): number {
  return kind === "agent" ? 1 + Math.max(targetHop ?? 0, wakeHop ?? 0) : 0;
}

export function wakesAllowed(hop: number): boolean {
  return hop < LIMITS.HOP_LIMIT;
}

export function gateRefuses(kind: AuthorKind, agentRun: number): boolean {
  return kind === "agent" && agentRun >= LIMITS.HUMAN_GATE;
}

export function nextAgentRun(kind: AuthorKind, agentRun: number): number {
  if (kind === "human") return 0;
  return kind === "agent" ? agentRun + 1 : agentRun;
}

export type Recent = { author_id: string; author_kind: AuthorKind; created_at: number };

export function orderedPair(x: string, y: string): { a: string; b: string } {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

/**
 * The pair that alternated more than PAIR_ALTERNATIONS times at the end of `recent` (oldest first) within the
 * window, or null. Hub messages are skipped; a human or a third agent ends the run.
 */
export function pairTrip(recent: Recent[], now: number): { a: string; b: string } | null {
  const xs = recent.filter((r) => r.author_kind !== "hub" && now - r.created_at <= LIMITS.PAIR_WINDOW_MS);
  const last = xs[xs.length - 1];
  const prev = xs[xs.length - 2];
  if (!last || !prev || last.author_kind !== "agent" || prev.author_kind !== "agent" || last.author_id === prev.author_id) return null;
  const pair = [last.author_id, prev.author_id];
  let run = 1;
  for (let i = xs.length - 1; i > 0; i--) {
    const cur = xs[i]!;
    const before = xs[i - 1]!;
    if (before.author_kind !== "agent" || before.author_id === cur.author_id || !pair.includes(before.author_id)) break;
    run++;
  }
  return run - 1 > LIMITS.PAIR_ALTERNATIONS ? orderedPair(last.author_id, prev.author_id) : null;
}

export type Verdict = { ok: true } | { ok: false; retry_after_s: number };

export function windowVerdict(stamps: number[], now: number, windowMs: number, limit: number): Verdict {
  const inside = stamps.filter((t) => now - t < windowMs).sort((a, b) => a - b);
  if (inside.length < limit) return { ok: true };
  const mustExpire = inside[inside.length - limit]!;
  return { ok: false, retry_after_s: Math.max(1, Math.ceil((mustExpire + windowMs - now) / 1000)) };
}

/** Spec 6.5 per-identity and per-session limits; the longest wait wins. */
export function postVerdict(q: { is_agent: boolean; session: number[]; identity: number[]; now: number }): Verdict {
  const checks: Array<[number[], number, number]> = q.is_agent
    ? [[q.session, 60_000, LIMITS.SESSION_PER_MIN], [q.session, 3_600_000, LIMITS.SESSION_PER_HOUR], [q.identity, 86_400_000, LIMITS.AGENT_PER_DAY]]
    : [[q.identity, 60_000, LIMITS.HUMAN_PER_MIN]];
  let worst: Verdict = { ok: true };
  for (const [stamps, windowMs, limit] of checks) {
    const v = windowVerdict(stamps, q.now, windowMs, limit);
    if (!v.ok && (worst.ok || v.retry_after_s > worst.retry_after_s)) worst = v;
  }
  return worst;
}
