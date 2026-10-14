// Shared wire vocabulary. Never accept URL values, selectors, labels or user content.
export const TIMING_PATHS = ["/", "/docket", "/people", "/apps", "/jump", "/search", "/assistant", "/assistant/tools", "/assistant/chat", "/do", "/new", "/attention", "/mail", "/mail/:message", "/mail/recipients", "/c", "/c/:channel", "/c/:channel/t/:number", "/inbox", "/usage", "/situations", "/archive", "/skills", "/skills/:skill", "/projects/new", "/me", "/me/sessions", "/admin/:section", "/people/:person", "/:project", "/:project/docket", "/:project/w/:number", "/:project/graph", "/:project/frontier", "/:project/board", "/:project/status", "/:project/code", "/:project/files", "/:project/reviews", "/:project/reviews/:number", "/:project/wiki", "/:project/wiki/:slug", "/:project/documents", "/:project/contacts", "/:project/contacts/:entity", "/api/:verb", "/voice/:operation", "/chat/v1/ws", "/other"];
export const TIMING_NAMES = ["navigation", "dns", "connect", "tls", "ttfb", "response", "dom.interactive", "load", "lcp", "cls", "longtask", "list.select", "docket.select", "pane.swap", "form.submit", "inspector.open", "chat.send", "assistant.send", "search", "chat.connect", "chat.reconnect", "presence.connect", "presence.reconnect", "assistant.first-token", "voice.transcribe", "voice.correct"];
export const TIMING_PHASES = ["page", "paint", "fetch", "spinner", "connection", "first-token"];
export type ClientPoint = { path: string; previous: string; name: string; phase: string; request: string; duration: number };
export function validClientPoint(value: unknown): value is ClientPoint {
  const x = value as ClientPoint;
  return !!x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === 6 && Object.keys(x).every(k => ["path", "previous", "name", "phase", "request", "duration"].includes(k)) &&
    TIMING_PATHS.includes(x.path) && TIMING_PATHS.includes(x.previous) && TIMING_NAMES.includes(x.name) && TIMING_PHASES.includes(x.phase) &&
    typeof x.request === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x.request) &&
    typeof x.duration === "number" && Number.isFinite(x.duration) && x.duration >= 0 && x.duration <= 3_600_000;
}
// Used by both browser and tests; its source is embedded in the static asset.
export function timingPath(url: string): string {
  const p = new URL(url, "https://pimwell.invalid").pathname;
  if (["/", "/docket", "/people", "/apps", "/jump", "/search", "/assistant", "/assistant/tools", "/assistant/chat", "/do", "/new", "/attention", "/mail", "/mail/recipients", "/c", "/inbox", "/usage", "/situations", "/archive", "/skills", "/projects/new", "/me", "/me/sessions"].includes(p)) return p;
  if (/^\/api\//.test(p)) return "/api/:verb";
  if (/^\/voice\//.test(p)) return "/voice/:operation";
  if (p === "/chat/v1/ws") return p;
  if (/^\/c\/[^/]+\/t\/\d+$/.test(p)) return "/c/:channel/t/:number";
  if (/^\/c\/[^/]+$/.test(p)) return "/c/:channel";
  for (const section of ["admin", "people", "mail", "skills"]) if (new RegExp("^/" + section + "/[^/]+$").test(p)) return {admin:"/admin/:section",people:"/people/:person",mail:"/mail/:message",skills:"/skills/:skill"}[section]!;
  if (/^\/[^/]+\/w\/\d+$/.test(p)) return "/:project/w/:number";
  if (/^\/[^/]+\/reviews\/\d+$/.test(p)) return "/:project/reviews/:number";
  if (/^\/[^/]+\/wiki\/[^/]+$/.test(p)) return "/:project/wiki/:slug";
  if (/^\/[^/]+\/contacts\/[^/]+$/.test(p)) return "/:project/contacts/:entity";
  const m = /^\/[^/]+\/(docket|graph|frontier|board|status|code|files|reviews|wiki|documents|contacts)$/.exec(p);
  if (m) return "/:project/" + m[1];
  if (/^\/[^/]+$/.test(p)) return "/:project";
  return "/other";
}
