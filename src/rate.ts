import { sha256Hex } from "./ids";

export const RATE_WINDOW_MS = 3600 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * RATE_WINDOW_MS;

export const RATE_RULES = {
  addr: { limit: 3, windowMs: RATE_WINDOW_MS },
  ip: { limit: 20, windowMs: RATE_WINDOW_MS },
  // MCP spec 10.6
  oauth_register_ip: { limit: 10, windowMs: RATE_WINDOW_MS },
  oauth_register_all: { limit: 200, windowMs: DAY_MS },
  oauth_authorize_ip: { limit: 60, windowMs: RATE_WINDOW_MS },
  oauth_token_client: { limit: 60, windowMs: MINUTE_MS },
  oauth_token_ip: { limit: 120, windowMs: MINUTE_MS },
  mcp_anon_ip: { limit: 60, windowMs: MINUTE_MS },
  mcp_grant_minute: { limit: 120, windowMs: MINUTE_MS },
  mcp_grant_hour: { limit: 2000, windowMs: RATE_WINDOW_MS },
  // Headless agents on /agent/mcp, per long-lived token: the same allowance as one assistant connection.
  agent_mcp_minute: { limit: 120, windowMs: MINUTE_MS },
  agent_mcp_hour: { limit: 2000, windowMs: RATE_WINDOW_MS },
  // Claiming connect links, per IP: links are unguessable, so this only slows down someone trying.
  connect_ip: { limit: 20, windowMs: RATE_WINDOW_MS },
  // The in-context Playground: per browser session, like one assistant connection.
  playground_session: { limit: 120, windowMs: MINUTE_MS },
  // Each proposal is a model call: per person, per hour.
  propose_identity: { limit: 20, windowMs: RATE_WINDOW_MS },
  assistant_turn: { limit: 120, windowMs: RATE_WINDOW_MS },
  // Voice: each clip is a transcription and a correction, per person, per hour.
  voice_identity: { limit: 240, windowMs: RATE_WINDOW_MS },
  // The "What do you want to do?" box: one small model call each, per person, per hour.
  intent_identity: { limit: 200, windowMs: RATE_WINDOW_MS },
} as const;
export type RateBucket = keyof typeof RATE_RULES;

export type RateResult = { ok: boolean; first: boolean; retryAfterS: number };

// Fixed windows in KV. Subjects are hashed so keys hold no addresses.
// KV is eventually consistent; a burst at the edge may slightly exceed the cap.
// `first` is true only on the first denial in a window, so callers can log once.
// KV rejects (429) when one key is written more than about once a second. A counter write that fails
// fails open for the MCP and OAuth buckets: the decision already computed from the read stands.
async function putCounter(kv: KVNamespace, bucket: RateBucket, key: string, value: string, ttl: number): Promise<void> {
  try {
    await kv.put(key, value, { expirationTtl: ttl });
  } catch (e) {
    // The email buckets (addr, ip) keep failing closed: requestLink relies on it so a KV outage sends no mail.
    if (bucket === "addr" || bucket === "ip") throw e;
    console.log("rate write failed", e instanceof Error ? e.name : "error");
  }
}

/**
 * `defer`, when given, takes the counter write off the response path for buckets whose writes already fail open: the
 * decision comes from the read either way. The email buckets (addr, ip) always wait, because they fail closed.
 */
export async function takeRateDetail(
  kv: KVNamespace, bucket: RateBucket, subject: string, now: number, defer?: (p: Promise<unknown>) => void,
): Promise<RateResult> {
  const { limit, windowMs } = RATE_RULES[bucket];
  const write = (p: Promise<void>): Promise<void> | undefined => {
    if (!defer || bucket === "addr" || bucket === "ip") return p;
    defer(p);
    return undefined;
  };
  const window = Math.floor(now / windowMs);
  const retryAfterS = Math.max(1, Math.ceil(((window + 1) * windowMs - now) / 1000));
  const ttl = Math.max(60, Math.ceil((2 * windowMs) / 1000));
  const key = `rl:${bucket}:${window}:${await sha256Hex(subject.trim().toLowerCase())}`;
  let used: number;
  try {
    used = Number((await kv.get(key)) ?? "0");
  } catch (e) {
    // A read failure must not turn a /mcp call into a 500: the per-grant MCP buckets treat it as allowed.
    if (!bucket.startsWith("mcp_grant_")) throw e;
    console.log("rate read failed", e instanceof Error ? e.name : "error");
    return { ok: true, first: false, retryAfterS };
  }
  if (used >= limit) {
    const overKey = `${key}:over`;
    let marked: string | null;
    try {
      marked = await kv.get(overKey);
    } catch (e) {
      // Still denied; only the once-per-window "first" signal is lost. The email buckets keep failing closed.
      if (bucket === "addr" || bucket === "ip") throw e;
      console.log("rate marker read failed", e instanceof Error ? e.name : "error");
      return { ok: false, first: false, retryAfterS };
    }
    if (marked !== null) return { ok: false, first: false, retryAfterS };
    await write(putCounter(kv, bucket, overKey, "1", ttl));
    return { ok: false, first: true, retryAfterS };
  }
  await write(putCounter(kv, bucket, key, String(used + 1), ttl));
  return { ok: true, first: false, retryAfterS };
}

/**
 * The same decision as `takeRateDetail`, from one atomic D1 statement instead of KV (MCP spec 10.6): the
 * per-grant and per-IP MCP buckets need counts that cannot be lost to eventual consistency or same-key write
 * limits. `first` is true for exactly the first denied call in a window (the count passes the limit by one).
 * A D1 failure fails open: the same database is needed to serve the call anyway.
 */
export async function takeRateAtomic(db: D1Database, bucket: RateBucket, subject: string, now: number): Promise<RateResult> {
  const { limit, windowMs } = RATE_RULES[bucket];
  const window = Math.floor(now / windowMs);
  const retryAfterS = Math.max(1, Math.ceil(((window + 1) * windowMs - now) / 1000));
  const key = `${bucket}:${await sha256Hex(subject.trim().toLowerCase())}`;
  try {
    const row = await db.prepare(
      `INSERT INTO rate_counter ("key", "window", count, expires_at) VALUES (?, ?, 1, ?)
       ON CONFLICT("key", "window") DO UPDATE SET count = count + 1 RETURNING count`,
    ).bind(key, window, (window + 2) * windowMs).first<{ count: number }>();
    const count = row?.count ?? 1;
    if (count === 1) {
      // A new window for this key: sweep counters whose window is long over.
      await db.prepare("DELETE FROM rate_counter WHERE expires_at < ?").bind(now).run().catch(() => undefined);
    }
    return { ok: count <= limit, first: count === limit + 1, retryAfterS };
  } catch (e) {
    console.log("rate counter failed", e instanceof Error ? e.name : "error");
    return { ok: true, first: false, retryAfterS };
  }
}

/**
 * Several atomic counters for one subject in a single round trip (MCP calls count per minute and per hour). The
 * sweep of finished windows runs after the response when `defer` is given. Fails open, like takeRateAtomic.
 */
export async function takeRatesAtomic(db: D1Database, buckets: RateBucket[], subject: string, now: number, defer?: (p: Promise<unknown>) => void): Promise<Array<RateResult & { bucket: RateBucket }>> {
  const hash = await sha256Hex(subject.trim().toLowerCase());
  const plan = buckets.map((bucket) => {
    const { limit, windowMs } = RATE_RULES[bucket];
    const window = Math.floor(now / windowMs);
    return { bucket, limit, window, windowMs, retryAfterS: Math.max(1, Math.ceil(((window + 1) * windowMs - now) / 1000)) };
  });
  try {
    const rows = await db.batch(plan.map((x) => db.prepare(
      `INSERT INTO rate_counter ("key", "window", count, expires_at) VALUES (?, ?, 1, ?)
       ON CONFLICT("key", "window") DO UPDATE SET count = count + 1 RETURNING count`,
    ).bind(`${x.bucket}:${hash}`, x.window, (x.window + 2) * x.windowMs)));
    const counts = rows.map((r) => (r.results[0] as { count: number } | undefined)?.count ?? 1);
    if (counts.some((c) => c === 1)) {
      const sweep = db.prepare("DELETE FROM rate_counter WHERE expires_at < ?").bind(now).run().catch(() => undefined);
      if (defer) defer(sweep); else await sweep;
    }
    return plan.map((x, i) => ({ bucket: x.bucket, ok: counts[i]! <= x.limit, first: counts[i] === x.limit + 1, retryAfterS: x.retryAfterS }));
  } catch (e) {
    console.log("rate counter failed", e instanceof Error ? e.name : "error");
    return plan.map((x) => ({ bucket: x.bucket, ok: true, first: false, retryAfterS: x.retryAfterS }));
  }
}

export async function takeRate(kv: KVNamespace, bucket: RateBucket, subject: string, now: number): Promise<boolean> {
  return (await takeRateDetail(kv, bucket, subject, now)).ok;
}
