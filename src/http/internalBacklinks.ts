import type { Env } from "../env";
import { roleFor } from "../auth/context";
import { getIdentityById } from "../db/identities";
import { getMembership } from "../db/memberships";
import { getTenantBySlug } from "../db/tenants";
import { isValidTenantSlug } from "../tenant";
import { backlinks } from "../chat/backlinks";
import { backlinkTarget } from "../chat/refs";
import { isInternalCall } from "./internal";
import { notFoundPage } from "./pages";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/**
 * Messaging spec 5.3: "Discussed in" for Ardi pages over the HUB service binding, filtered to what the principal
 * Ardi asserts may read. Ids, times, and links only; never message text.
 */
export async function internalBacklinks(request: Request, env: Env): Promise<Response> {
  if (!(await isInternalCall(request, env))) return notFoundPage();
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ ok: false });
    input = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false });
  }
  const slug = typeof input.tenant === "string" ? input.tenant.trim().toLowerCase() : "";
  const principal = typeof input.principal === "string" ? input.principal : "";
  const target = typeof input.kind === "string" && typeof input.key === "string" ? backlinkTarget(input.kind, input.key) : null;
  const limit = typeof input.limit === "number" && Number.isSafeInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 50) : 20;
  if (!isValidTenantSlug(slug) || !principal || !target || (target.kind !== "commit" && target.kind !== "ticket")) return json({ ok: false });
  const tenant = await getTenantBySlug(env.HUB_DB, slug);
  if (!tenant || tenant.state !== "active") return json({ ok: false });
  const identity = await getIdentityById(env.HUB_DB, principal);
  const role = identity ? roleFor(identity, await getMembership(env.HUB_DB, identity.id, tenant.id)) : null;
  if (!identity || !role) return json({ ok: false });
  const items = await backlinks(env.HUB_DB, { tenant, identity, role, session: null }, target, limit);
  return json({
    ok: true, count: items.length,
    items: items.map((b) => ({ channel: b.channel, seq: b.seq, msg_id: b.msg_id, created_at: b.created_at, url: `https://${tenant.slug}.${env.HUB_DOMAIN}/m/${b.msg_id}` })),
  });
}
