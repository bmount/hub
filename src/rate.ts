import { sha256Hex } from "./ids";

export const RATE_WINDOW_MS = 3600 * 1000;
export const RATE_LIMITS = { addr: 3, ip: 20 } as const;
export type RateBucket = keyof typeof RATE_LIMITS;

// Fixed hourly window in KV. Subjects are hashed so keys hold no addresses.
// KV is eventually consistent; a burst at the edge may slightly exceed the cap.
// `first` is true only on the first denial in a window, so callers can log once.
export async function takeRateDetail(kv: KVNamespace, bucket: RateBucket, subject: string, now: number): Promise<{ ok: boolean; first: boolean }> {
  const window = Math.floor(now / RATE_WINDOW_MS);
  const key = `rl:${bucket}:${window}:${await sha256Hex(subject.trim().toLowerCase())}`;
  const used = Number((await kv.get(key)) ?? "0");
  if (used >= RATE_LIMITS[bucket]) {
    const overKey = `${key}:over`;
    if ((await kv.get(overKey)) !== null) return { ok: false, first: false };
    await kv.put(overKey, "1", { expirationTtl: 2 * 3600 });
    return { ok: false, first: true };
  }
  await kv.put(key, String(used + 1), { expirationTtl: 2 * 3600 });
  return { ok: true, first: false };
}

export async function takeRate(kv: KVNamespace, bucket: RateBucket, subject: string, now: number): Promise<boolean> {
  return (await takeRateDetail(kv, bucket, subject, now)).ok;
}
