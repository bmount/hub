// Content-safe tail boundary: arbitrary messages, URL paths/query names and version messages never leave
// the tail Worker. Keep fixed operational labels, exception types, counts, Ray IDs and commit/version metadata.
// Invocation logs and raw Workers Logs persistence are disabled in every source configuration.

export type AppLog = { level: "warn" | "error"; text: string };
export type AppUsage = { provider: string; model: string; input_tokens: number; output_tokens: number; cached_tokens: number | null; cost_usd: number | null; purpose: string | null };
export type AppEvent = {
  script: string; version: string | null; tag: string | null; message: string | null; at: number; outcome: string;
  method: string | null; path: string | null; status: number | null; ray: string | null;
  logs: AppLog[]; exceptions: Array<{ name: string; message: string }>; usage: AppUsage[];
};

const TEXT_MAX = 1000;
const LOGS_MAX = 20;
// Only fixed operational labels can cross the boundary; never arbitrary error strings.
const SAFE_LOGS = new Set([
  "early adopter alert", "early adopter alert failed", "sign-in email failed", "pre-publish AI review failed",
  "auto moderation failed", "recording usage failed", "ai review failed", "merchant assessment failed",
  "reply rejected (sender likely failed DMARC)", "early adopter review failed", "sandbox turn failed",
  "voice request failed", "interview turn failed", "suggest edits failed", "request exception",
  "verb failed", "mcp error", "push sync failed", "Pimwell telemetry test exception",
]);

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
    // Even path segments and query *names* can contain user content or credentials.
    return u.pathname === "/" ? "/" : "/[redacted]";
  } catch { return null; }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const SAFE_MODELS = new Set(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "omni-moderation-latest"]);
const name = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max && /^[\w.:/@+-]+$/.test(v) ? v : null);

/** A structured AI usage line: console.log(JSON.stringify({ pimwell: "ai_usage", provider, model, input_tokens, output_tokens, ... })). */
export function usageFrom(parts: unknown[]): AppUsage | null {
  let o: unknown = parts.length === 1 ? parts[0] : null;
  if (typeof o === "string" && o.startsWith("{") && o.includes("ai_usage")) { try { o = JSON.parse(o); } catch { return null; } }
  if (!o || typeof o !== "object") return null;
  const x = o as Record<string, unknown>;
  if (x.pimwell !== "ai_usage") return null;
  const provider = name(x.provider, 40), model = name(x.model, 80), i = num(x.input_tokens), out = num(x.output_tokens);
  if (provider !== "openai" || !model || !SAFE_MODELS.has(model) || i === null || out === null) return null;
  const cost = typeof x.cost_usd === "number" && Number.isFinite(x.cost_usd) && x.cost_usd >= 0 && x.cost_usd <= 10_000 ? x.cost_usd : null;
  return { provider: provider.toLowerCase(), model, input_tokens: Math.min(i, 50_000_000), output_tokens: Math.min(out, 50_000_000), cached_tokens: num(x.cached_tokens), cost_usd: cost, purpose: null };
}

type TailLike = {
  scriptName?: string | null; entrypoint?: string; outcome?: string; eventTimestamp?: number | null;
  scriptVersion?: { id?: string; tag?: string; message?: string } | null;
  event?: { rpcMethod?: string; request?: { url?: string; method?: string; headers?: Record<string, string> }; response?: { status?: number } } | null;
  logs?: Array<{ level?: string; message?: unknown[] }>; exceptions?: Array<{ name?: string; message?: string }>;
};

/** One tail item to what Pimwell may keep, or null when there is nothing worth sending. */
export function redact(t: TailLike): AppEvent | null {
  if (!t.scriptName) return null;
  // Tail delivery itself is a hub invocation. Forwarding it would create an endless RPC/tail feedback loop.
  if (t.scriptName === "pimwell-hub" && (t.entrypoint === "Ingest" || t.event?.rpcMethod === "events")) return null;
  const req = t.event?.request;
  const logs: AppLog[] = [];
  const usage: AppUsage[] = [];
  for (const l of t.logs ?? []) {
    const parts = Array.isArray(l.message) ? l.message : [l.message];
    const u = usageFrom(parts);
    if (u) { if (usage.length < 50) usage.push(u); continue; }
    if ((l.level === "warn" || l.level === "error") && logs.length < LOGS_MAX) {
      const label = parts.length === 1 && typeof parts[0] === "string" && SAFE_LOGS.has(parts[0]) ? parts[0] : `[redacted ${l.level}]`;
      logs.push({ level: l.level, text: label });
    }
  }
  const exceptions = (t.exceptions ?? []).slice(0, 10).map((e) => ({
    name: ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError"].includes(e.name ?? "") ? e.name! : "Error",
    message: e.message === "Pimwell telemetry test exception" ? e.message : "[redacted exception]",
  }));
  return {
    script: cap(t.scriptName, 100), version: t.scriptVersion?.id ? cap(t.scriptVersion.id, 64) : null,
    tag: /^[0-9a-f]{7,40}$/.test(t.scriptVersion?.tag ?? "") ? t.scriptVersion!.tag! : null, message: null,
    at: typeof t.eventTimestamp === "number" ? t.eventTimestamp : Date.now(), outcome: cap(t.outcome ?? "unknown", 40),
    method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(req?.method ?? "") ? req!.method! : null, path: redactPath(req?.url), status: typeof t.event?.response?.status === "number" ? t.event.response.status : null,
    ray: req?.headers?.["cf-ray"] ? cap(req.headers["cf-ray"], 40) : null, logs, exceptions, usage,
  };
}
