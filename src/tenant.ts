export const RESERVED_LABELS: Set<string> = new Set([
  "www", "mail", "mx", "api", "mcp", "login", "signup", "admin", "root", "static", "cdn", "git", "ardi",
]);

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

export function isValidTenantSlug(s: string): boolean {
  return isValidSlug(s) && !s.startsWith("_") && !RESERVED_LABELS.has(s);
}

export type HostKind = { kind: "apex" } | { kind: "tenant"; slug: string } | { kind: "unknown" };

export function classifyHost(hostHeader: string | null, hubDomain: string): HostKind {
  if (!hostHeader) return { kind: "unknown" };
  const host = hostHeader.toLowerCase().split(":")[0]!;
  const domain = hubDomain.toLowerCase();
  if (host === domain) return { kind: "apex" };
  const suffix = "." + domain;
  if (!host.endsWith(suffix)) return { kind: "unknown" };
  const label = host.slice(0, host.length - suffix.length);
  if (label.includes(".") || !isValidTenantSlug(label)) return { kind: "unknown" };
  return { kind: "tenant", slug: label };
}
