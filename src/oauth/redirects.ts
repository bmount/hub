export type RedirectPattern = { pattern: string; label: string };
export type RedirectMatch = { host: string; label: string; loopback: boolean };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * MCP spec 6.2. The URI must already be in canonical form (so case tricks, default ports, and dot
 * segments fail), carry no userinfo, query, or fragment, and match a pattern exactly on scheme, host,
 * and path. https patterns take no port; loopback patterns (http, localhost or 127.0.0.1) take any port.
 */
export function matchRedirect(patterns: RedirectPattern[], uri: string): RedirectMatch | null {
  if (uri.length > 512 || /[\s\\]/.test(uri)) return null;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash || uri.includes("#") || uri.includes("?")) return null;
  if (`${u.protocol}//${u.host}${u.pathname}` !== uri) return null;
  const loopback = u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
  for (const p of patterns) {
    const q = new URL(p.pattern);
    if (q.protocol !== u.protocol || q.hostname !== u.hostname || q.pathname !== u.pathname) continue;
    if (loopback) return { host: "loopback", label: p.label, loopback: true };
    if (u.protocol === "https:" && u.port === "") return { host: u.hostname, label: p.label, loopback: false };
  }
  return null;
}

export async function loadRedirectPatterns(db: D1Database): Promise<RedirectPattern[]> {
  const r = await db.prepare("SELECT pattern, label FROM oauth_redirect_allow ORDER BY pattern").all<RedirectPattern>();
  return r.results;
}

export async function redirectAllowed(db: D1Database, uri: string): Promise<RedirectMatch | null> {
  return matchRedirect(await loadRedirectPatterns(db), uri);
}
