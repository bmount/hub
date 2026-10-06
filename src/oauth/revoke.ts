import type { Env } from "../env";
import { recordEvent } from "../db/events";
import { revokeGrantRows } from "../db/oauthGrants";
import type { OAuthGrant } from "../db/types";
import { authServer } from "./config";

/** Delete the library grant and its tokens. Best effort: D1 is the revocation authority (MCP spec 5.2, 10.2). */
export async function dropLibraryGrant(env: Env, grant: OAuthGrant): Promise<void> {
  if (!grant.library_grant_id) return;
  try {
    await authServer(env, grant.resource).getOAuthApi(env).revokeGrant(grant.library_grant_id, grant.identity_id);
  } catch (e) {
    console.log("library grant revoke failed", e instanceof Error ? e.name : "error");
  }
}

/**
 * Revoke one grant: D1 rows in one batch (effective on the next request), an `oauth.grant.revoke` event,
 * then the library grant. `actor` is who did it; system revocations (refresh reuse) act as the grant's own session.
 */
export async function revokeOAuthGrant(
  env: Env, grant: OAuthGrant, actor: { identity_id: string; session_id: string } | null, reason: string, now: number,
): Promise<boolean> {
  const revoked = await revokeGrantRows(env.HUB_DB, grant.id, actor?.identity_id ?? null, reason, now);
  if (revoked) {
    await recordEvent(env.HUB_DB, {
      tenant_id: grant.tenant_id, identity_id: actor?.identity_id ?? grant.identity_id, session_id: actor?.session_id ?? grant.session_id,
      kind: "oauth.grant.revoke", target_kind: "oauth_grant", target_id: grant.id, summary: `Revoked "${grant.client_name}" (${reason})`,
    }, now);
  }
  await dropLibraryGrant(env, grant);
  return revoked;
}
