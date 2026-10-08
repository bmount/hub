// Request logging (docs/ops/logging.md). Each request gets one structured JSON line in Workers Logs, written by the
// first middleware once the response is ready. Handlers add what they learn through `note`: who acted, in which
// organization, which verb, and why it failed. Secrets never reach the log: token-bearing paths are reduced to
// their route, and query strings keep only their key names.
import type { Ctx } from "./auth/context";

export type LogNote = {
  actor?: { id: string; kind: string; email: string; root?: boolean } | null;
  tenant?: string | null;
  auth?: string | null;
  via?: string;
  verb?: string;
  error?: { reason: string; detail?: string | null };
};

const NOTES = new WeakMap<Request, LogNote>();

/** Add facts about this request to its log line. Later notes override earlier ones, field by field. */
export function note(request: Request, n: LogNote): void {
  NOTES.set(request, { ...NOTES.get(request), ...n });
}

/** Note who is acting, from a built context. */
export function noteCtx(request: Request, ctx: Ctx, via?: string): void {
  note(request, {
    actor: ctx.identity ? { id: ctx.identity.id, kind: ctx.identity.kind, email: ctx.identity.email, ...(ctx.identity.is_root === 1 ? { root: true } : {}) } : null,
    tenant: ctx.tenant?.slug ?? null,
    auth: ctx.authKind,
    ...(via ? { via } : {}),
  });
}

export function notesFor(request: Request): LogNote {
  return NOTES.get(request) ?? {};
}

// Routes whose path carries a secret: keep the route, drop the secret.
const SECRET_PATHS: Array<[RegExp, string]> = [
  [/^\/invite\/[^/]+/, "/invite/:token"],
  [/^\/auth\/[^/]+/, "/auth/:token"],
  [/^\/connect\/[^/]+/, "/connect/:token"],
];

/** The path with secrets removed, and the query reduced to its key names (values may be tokens or addresses). */
export function redactUrl(url: URL): string {
  let path = url.pathname;
  for (const [re, route] of SECRET_PATHS) if (re.test(path)) { path = path.replace(re, route); break; }
  const keys = [...new Set([...url.searchParams.keys()])];
  return keys.length ? `${path}?${keys.map((k) => `${encodeURIComponent(k)}=…`).join("&")}` : path;
}

export type RequestLine = {
  msg: "request"; method: string; host: string; path: string; status: number; ms: number;
  db: { trips: number; statements: number; ms: number }; ray: string | null; ip: string | null; country: string | null; ua: string | null;
} & LogNote;

export function requestLine(request: Request, status: number, ms: number, db: { trips: number; statements: number; ms: number }): RequestLine {
  const url = new URL(request.url);
  const cf = (request as unknown as { cf?: { country?: string } }).cf;
  return {
    msg: "request", method: request.method, host: request.headers.get("host") ?? url.host, path: redactUrl(url), status, ms,
    db: { trips: db.trips, statements: db.statements, ms: db.ms },
    ray: request.headers.get("cf-ray"), ip: request.headers.get("cf-connecting-ip"), country: cf?.country ?? null,
    ua: (request.headers.get("user-agent") ?? "").slice(0, 160) || null,
    ...notesFor(request),
  };
}

/** One structured line: errors at error level so they stand out in Workers Logs. */
export function emit(line: Record<string, unknown> & { status?: number }): void {
  const text = JSON.stringify(line);
  if ((line.status ?? 0) >= 500) console.error(text);
  else if ((line.status ?? 0) >= 400) console.warn(text);
  else console.log(text);
}
