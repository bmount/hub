// What leaves an app's tail stream for Pimwell (design 2026-10-07, A1.2). Runs inside pimwell-tail, before anything
// is sent: paths without query values, no headers but the Ray ID, only warnings, errors and exceptions (info lines
// are dropped), credentials and email addresses masked, everything capped. AI usage lines are kept as numbers.

export type AppLog = { level: "warn" | "error"; text: string };
export type AppUsage = { provider: string; model: string; input_tokens: number; output_tokens: number; cached_tokens: number | null; cost_usd: number | null; purpose: string | null };
export type AppEvent = {
  script: string; version: string | null; tag: string | null; message: string | null; at: number; outcome: string;
  method: string | null; path: string | null; status: number | null; ray: string | null;
  logs: AppLog[]; exceptions: Array<{ name: string; message: string }>; usage: AppUsage[];
};

const TEXT_MAX = 1000;
const LOGS_MAX = 20;

/** Anything shaped like a credential or an address becomes a placeholder. */
export function mask(s: string): string {
  return s
    .replace(/\bpm[swi]_[A-Za-z0-9_-]{8,}/g, "[token]")
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, "[key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [token]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b(password|secret|token|api[_-]?key)(["']?\s*[:=]\s*)["']?[^\s"',}]+/gi, "$1$2[redacted]");
}

const cap = (s: string, n = TEXT_MAX) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function redactPath(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const keys = [...new Set([...u.searchParams.keys()])].slice(0, 20);
    return cap(mask(u.pathname) + (keys.length ? `?${keys.map((k) => `${encodeURIComponent(k)}=…`).join("&")}` : ""), 300);
  } catch { return null; }
}

function stringify(parts: unknown[]): string {
  return parts.map((p) => (typeof p === "string" ? p : (() => { try { return JSON.stringify(p); } catch { return String(p); } })())).join(" ");
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const name = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max && /^[\w.:/@+-]+$/.test(v) ? v : null);

/** A structured AI usage line: console.log(JSON.stringify({ pimwell: "ai_usage", provider, model, input_tokens, output_tokens, ... })). */
export function usageFrom(parts: unknown[]): AppUsage | null {
  let o: unknown = parts.length === 1 ? parts[0] : null;
  if (typeof o === "string" && o.startsWith("{") && o.includes("ai_usage")) { try { o = JSON.parse(o); } catch { return null; } }
  if (!o || typeof o !== "object") return null;
  const x = o as Record<string, unknown>;
  if (x.pimwell !== "ai_usage") return null;
  const provider = name(x.provider, 40), model = name(x.model, 80), i = num(x.input_tokens), out = num(x.output_tokens);
  if (!provider || !model || i === null || out === null) return null;
  const cost = typeof x.cost_usd === "number" && Number.isFinite(x.cost_usd) && x.cost_usd >= 0 && x.cost_usd <= 10_000 ? x.cost_usd : null;
  return { provider: provider.toLowerCase(), model, input_tokens: Math.min(i, 50_000_000), output_tokens: Math.min(out, 50_000_000), cached_tokens: num(x.cached_tokens), cost_usd: cost, purpose: name(x.purpose, 40) };
}

type TailLike = {
  scriptName?: string | null; outcome?: string; eventTimestamp?: number | null;
  scriptVersion?: { id?: string; tag?: string; message?: string } | null;
  event?: { request?: { url?: string; method?: string; headers?: Record<string, string> }; response?: { status?: number } } | null;
  logs?: Array<{ level?: string; message?: unknown[] }>; exceptions?: Array<{ name?: string; message?: string }>;
};

/** One tail item to what Pimwell may keep, or null when there is nothing worth sending. */
export function redact(t: TailLike): AppEvent | null {
  if (!t.scriptName) return null;
  const req = t.event?.request;
  const logs: AppLog[] = [];
  const usage: AppUsage[] = [];
  for (const l of t.logs ?? []) {
    const parts = Array.isArray(l.message) ? l.message : [l.message];
    const u = usageFrom(parts);
    if (u) { if (usage.length < 50) usage.push(u); continue; }
    if ((l.level === "warn" || l.level === "error") && logs.length < LOGS_MAX) logs.push({ level: l.level, text: cap(mask(stringify(parts))) });
  }
  const exceptions = (t.exceptions ?? []).slice(0, 10).map((e) => ({ name: cap(String(e.name ?? "Error"), 100), message: cap(mask(String(e.message ?? ""))) }));
  return {
    script: cap(t.scriptName, 100), version: t.scriptVersion?.id ? cap(t.scriptVersion.id, 64) : null,
    tag: t.scriptVersion?.tag ? cap(mask(t.scriptVersion.tag), 100) : null, message: t.scriptVersion?.message ? cap(mask(t.scriptVersion.message), 200) : null,
    at: typeof t.eventTimestamp === "number" ? t.eventTimestamp : Date.now(), outcome: cap(t.outcome ?? "unknown", 40),
    method: req?.method ? cap(req.method, 10) : null, path: redactPath(req?.url), status: typeof t.event?.response?.status === "number" ? t.event.response.status : null,
    ray: req?.headers?.["cf-ray"] ? cap(req.headers["cf-ray"], 40) : null, logs, exceptions, usage,
  };
}
