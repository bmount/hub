import type { Env } from "../env";
import { credentialUsable, rank, roleFor } from "../auth/context";
import { getSessionByToken, touchSession } from "../db/sessions";
import { getIdentityById } from "../db/identities";
import { getTenantBySlug } from "../db/tenants";
import { getMembership } from "../db/memberships";
import { isValidTenantSlug } from "../tenant";
import { sha256Hex, timingSafeEqual } from "../ids";
import { notFoundPage } from "./pages";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
const denied = () => json({ ok: false });

/**
 * Service-binding calls only. Bindings deliver whatever URL the caller wrote, so the host proves nothing;
 * the shared secret does, and a cf-connecting-ip header (always present on public routes) disqualifies.
 */
export async function isInternalCall(request: Request, env: Env): Promise<boolean> {
  const secret = env.HUB_INTERNAL_SECRET;
  const given = request.headers.get("x-hub-internal");
  if (!secret || !given) return false;
  if (request.headers.has("cf-connecting-ip")) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  return timingSafeEqual(await sha256Hex(given), await sha256Hex(secret));
}

export async function introspect(request: Request, env: Env, now: number = Date.now()): Promise<Response> {
  if (!(await isInternalCall(request, env))) return notFoundPage();
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return denied();
    input = parsed as Record<string, unknown>;
  } catch {
    return denied();
  }
  const token = typeof input.token === "string" ? input.token : "";
  const slug = typeof input.tenant === "string" ? input.tenant.trim().toLowerCase() : "";
  if (!token.startsWith("pms_") || token.length > 128 || !isValidTenantSlug(slug)) return denied();

  const db = env.HUB_DB;
  const [session, tenant] = await Promise.all([getSessionByToken(db, token, now), getTenantBySlug(db, slug)]);
  if (!session || !tenant || tenant.state !== "active") return denied();
  const identity = await getIdentityById(db, session.identity_id);
  if (!identity || !(await credentialUsable(db, identity, session, null, tenant, "introspect"))) return denied();
  let role = roleFor(identity, await getMembership(db, identity.id, tenant.id));
  if (!role) return denied();
  // Agents can do what their person can, never more, and at most a member's rights (owner, 2026-10-08).
  if (identity.kind === "agent") {
    const op = identity.operator_id ? await getIdentityById(db, identity.operator_id) : null;
    const opRole = op ? roleFor(op, await getMembership(db, op.id, tenant.id)) : null;
    if (!opRole) return denied();
    if (rank(opRole) < rank(role)) role = opRole;
    if (rank(role) > rank("member")) role = "member";
  }
  // Shows on /me when a credential was last used; at most one write per hour, expiry unchanged.
  if (session.kind === "git") await touchSession(db, session, now);
  return json({
    ok: true,
    identity: { id: identity.id, kind: identity.kind, display_name: identity.display_name, email: identity.email, operator_id: identity.operator_id },
    session: { id: session.id, kind: session.kind, label: session.label },
    tenant: { slug: tenant.slug },
    role,
  });
}
