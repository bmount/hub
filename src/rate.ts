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
  mcp_anon_ip: { limit: 60, windowMs: MINUTE_MS },
  mcp_grant_minute: { limit: 120, windowMs: MINUTE_MS },
  mcp_grant_hour: { limit: 2000, windowMs: RATE_WINDOW_MS },
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

export async function takeRateDetail(kv: KVNamespace, bucket: RateBucket, subject: string, now: number): Promise<RateResult> {
  const { limit, windowMs } = RATE_RULES[bucket];
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
    if ((await kv.get(overKey)) !== null) return { ok: false, first: false, retryAfterS };
    await putCounter(kv, bucket, overKey, "1", ttl);
    return { ok: false, first: true, retryAfterS };
  }
  await putCounter(kv, bucket, key, String(used + 1), ttl);
  return { ok: true, first: false, retryAfterS };
}

export async function takeRate(kv: KVNamespace, bucket: RateBucket, subject: string, now: number): Promise<boolean> {
  return (await takeRateDetail(kv, bucket, subject, now)).ok;
}
