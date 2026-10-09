// Service bindings are an authentication boundary, not a payload-shape guarantee.
// Validate a bounded allowlisted copy before ingestion performs any database work.
import type { AppEvent, AppLog, AppUsage } from "./redact";

export const APP_BATCH_MAX = 500;
export const APP_EVENT_BYTES_MAX = 64 * 1024;
export const APP_BATCH_BYTES_MAX = 1024 * 1024;
export const APP_EVENT_AGE_MAX = 7 * 24 * 3_600_000;
export const APP_EVENT_FUTURE_MAX = 5 * 60_000;
const TOKENS_MAX = 50_000_000;
const encoder = new TextEncoder();

function record(x: unknown, keys: readonly string[]): x is Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  for (const key in x) if (!Object.hasOwn(x, key) || !keys.includes(key)) return false;
  return true;
}
const text = (x: unknown, max: number): x is string => typeof x === "string" && x.length <= max;
const nullableText = (x: unknown, max: number): x is string | null => x === null || text(x, max);
const tokens = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) <= TOKENS_MAX;
const name = (x: unknown, max: number): x is string => text(x, max) && x.length > 0 && /^[\w.:/@+-]+$/.test(x);

/** Null means the whole event is dropped, never partially trusted nested usage/logs. */
export function validatedAppEvent(raw: unknown, now: number): AppEvent | null {
  try {
    if (!record(raw, ["script", "version", "tag", "message", "at", "outcome", "method", "path", "status", "ray", "logs", "exceptions", "usage"])) return null;
    const e = raw;
    // The extra character permits redact()'s truncation ellipsis at existing caps.
    if (!text(e.script, 100) || !e.script.length || !nullableText(e.version, 65) || !nullableText(e.tag, 101) ||
        !nullableText(e.message, 201) || !text(e.outcome, 41) || !e.outcome.length || !nullableText(e.method, 11) ||
        !nullableText(e.path, 301) || !nullableText(e.ray, 41) ||
        !Number.isSafeInteger(e.at) || (e.at as number) < 0 || (e.at as number) < now - APP_EVENT_AGE_MAX || (e.at as number) > now + APP_EVENT_FUTURE_MAX ||
        !(e.status === null || (Number.isInteger(e.status) && (e.status as number) >= 100 && (e.status as number) <= 599)) ||
        !Array.isArray(e.logs) || e.logs.length > 50 || !Array.isArray(e.exceptions) || e.exceptions.length > 20 || !Array.isArray(e.usage) || e.usage.length > 50) return null;
    const logs: AppLog[] = [];
    for (const l of e.logs) {
      if (!record(l, ["level", "text"]) || (l.level !== "warn" && l.level !== "error") || !text(l.text, 1001)) return null;
      logs.push({ level: l.level, text: l.text });
    }
    const exceptions: AppEvent["exceptions"] = [];
    for (const x of e.exceptions) {
      if (!record(x, ["name", "message"]) || !text(x.name, 101) || !text(x.message, 1001)) return null;
      exceptions.push({ name: x.name, message: x.message });
    }
    const usage: AppUsage[] = [];
    for (const u of e.usage) {
      if (!record(u, ["provider", "model", "input_tokens", "output_tokens", "cached_tokens", "cost_usd", "purpose"]) ||
          !name(u.provider, 40) || !name(u.model, 80) || !tokens(u.input_tokens) || !tokens(u.output_tokens) ||
          !(u.cached_tokens === null || (tokens(u.cached_tokens) && u.cached_tokens <= u.input_tokens)) ||
          !(u.cost_usd === null || (typeof u.cost_usd === "number" && Number.isFinite(u.cost_usd) && u.cost_usd >= 0 && u.cost_usd <= 10_000)) ||
          !(u.purpose === null || name(u.purpose, 40))) return null;
      usage.push({ provider: u.provider, model: u.model, input_tokens: u.input_tokens, output_tokens: u.output_tokens,
        cached_tokens: u.cached_tokens, cost_usd: u.cost_usd, purpose: u.purpose });
    }
    const out: AppEvent = { script: e.script, version: e.version, tag: e.tag, message: e.message, at: e.at as number, outcome: e.outcome,
      method: e.method, path: e.path, status: e.status as number | null, ray: e.ray, logs, exceptions, usage };
    return encoder.encode(JSON.stringify(out)).byteLength <= APP_EVENT_BYTES_MAX ? out : null;
  } catch {
    // Also refuse pathological in-process objects; the public RPC receives structured data.
    return null;
  }
}

/** Bounds apply after RPC materialization, before SQL; not a transport-frame limit. */
export function validatedAppBatch(raw: unknown, now: number): AppEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: AppEvent[] = [];
  let bytes = 2; // JSON array brackets, plus commas below.
  for (let i = 0; i < Math.min(raw.length, APP_BATCH_MAX); i++) {
    const e = validatedAppEvent(raw[i], now);
    if (!e) continue;
    bytes += encoder.encode(JSON.stringify(e)).byteLength + (events.length ? 1 : 0);
    // Reject the selected batch atomically rather than accepting a size-dependent prefix.
    if (bytes > APP_BATCH_BYTES_MAX) return [];
    events.push(e);
  }
  return events;
}
