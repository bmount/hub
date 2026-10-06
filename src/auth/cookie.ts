export const COOKIE_NAME = "pmw_session";

function domainAttr(hubDomain: string): string {
  return hubDomain === "localhost" ? "" : `; Domain=.${hubDomain}`;
}

export function sessionCookie(token: string, hubDomain: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${365 * 24 * 3600}${domainAttr(hubDomain)}`;
}

export function clearSessionCookie(hubDomain: string): string {
  return `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0${domainAttr(hubDomain)}`;
}

export function readSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE_NAME) return rest.join("=") || null;
  }
  return null;
}
