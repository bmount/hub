import { defineVerb } from "./table";
import { reqString } from "./params";
import { notFound, unauthorized } from "../errors";
import { timingSafeEqual } from "../ids";
import { roleFor } from "../auth/context";
import { getTenantBySlug } from "../db/tenants";
import { getMembership } from "../db/memberships";
import { createGrant, replaceEarlierGrants, revokeGrantRows, setLibraryGrantId } from "../db/oauthGrants";
import { recordEvent } from "../db/events";
import { CONSENT_FRESH_PROOF_MINUTES, authServer, libraryGrantIdOf } from "../oauth/config";
import { deletePending, loadPending } from "../oauth/pending";

export const oauthGrantApprove = defineVerb({
  name: "oauth.grant.approve", kind: "command", scope: "hub", minRole: "public", freshProofMinutes: CONSENT_FRESH_PROOF_MINUTES, humanOnly: true,
  summary: "Approve a pending assistant connection for one tenant, from the consent page. Returns where to send the browser.",
  parse: (i) => ({ pending_id: reqString(i, "pending_id", { max: 64 }), form_token: reqString(i, "form_token", { max: 64 }) }),
  run: async (ctx, p) => {
    if (!ctx.identity || !ctx.session || ctx.session.kind !== "browser") throw unauthorized();
    const pending = await loadPending(ctx.env, p.pending_id, ctx.now);
    if (!pending || pending.session_id !== ctx.session.id || !pending.form_token || !timingSafeEqual(pending.form_token, p.form_token)) {
      throw notFound("no such request");
    }
    const tenant = await getTenantBySlug(ctx.db, pending.tenant_slug);
    const role = tenant && tenant.state === "active" ? roleFor(ctx.identity, await getMembership(ctx.db, ctx.identity.id, tenant.id)) : null;
    if (!tenant || role === null) throw notFound("no such request");
    // Single use: gone before any grant exists, so a replayed form cannot mint a second one.
    await deletePending(ctx.env, pending.id);
    const resource = pending.request.resource!;
    const { grant, session } = await createGrant(ctx.db, {
      identity_id: ctx.identity.id, tenant_id: tenant.id, client_id: pending.client_id, client_name: pending.client_name, client_kind: "dcr",
      redirect_host: pending.redirect_host, resource, scopes: pending.scopes, approved_by_session_id: ctx.session.id,
      last_proof_at: ctx.session.last_proof_at,
    }, ctx.now);
    let redirectTo: string;
    try {
      ({ redirectTo } = await authServer(ctx.env, resource).getOAuthApi(ctx.env).completeAuthorization({
        request: pending.request,
        userId: ctx.identity.id,
        scope: pending.scopes,
        metadata: { grant_id: grant.id },
        props: { grant_id: grant.id, session_id: session.id, identity_id: ctx.identity.id, tenant_id: tenant.id, resource, scopes: pending.scopes },
      }));
    } catch (e) {
      await revokeGrantRows(ctx.db, grant.id, ctx.identity.id, "authorization_failed", ctx.now);
      throw e;
    }
    const code = new URL(redirectTo).searchParams.get("code");
    const libraryGrantId = code ? libraryGrantIdOf(code) : null;
    if (libraryGrantId) await setLibraryGrantId(ctx.db, grant.id, libraryGrantId);
    // Only now that the library accepted the new grant does the earlier one for the same client and resource go.
    await replaceEarlierGrants(ctx.db, grant, ctx.now);
    await recordEvent(ctx.db, {
      tenant_id: tenant.id, identity_id: ctx.identity.id, session_id: ctx.session.id, kind: "oauth.grant.approve", target_kind: "oauth_grant",
      target_id: grant.id, summary: `Connected "${pending.client_name}" (${pending.redirect_host}) to ${tenant.slug} with ${pending.scopes.join(" ")}`,
    }, ctx.now);
    return { grant_id: grant.id, session_id: session.id, redirect_to: redirectTo };
  },
});
