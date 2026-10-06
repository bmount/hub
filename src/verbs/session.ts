import { defineVerb } from "./table";
import { optInt, optString, reqString } from "./params";
import { badRequest, forbidden, notFound, unauthorized } from "../errors";
import {
  AGENT_SESSION_DEFAULT_TTL_S, AGENT_SESSION_MAX_TTL_S, createAgentSession, createGitSession, getSessionById, listSessions, revokeSession,
} from "../db/sessions";
import { markApiTokenUsed } from "../db/apiTokens";
import { getIdentityById } from "../db/identities";
import { recordEvent } from "../db/events";
import { getGrantBySessionId } from "../db/oauthGrants";
import { revokeOAuthGrant } from "../oauth/revoke";
import { rank, type Ctx } from "../auth/context";
import { requireHuman, roleIn, targetTenant } from "../auth/authority";
import { esc } from "../html";
import type { Session } from "../db/types";

function requireIdentity(ctx: Ctx) {
  if (!ctx.identity || !ctx.session) throw unauthorized();
  return { identity: ctx.identity, session: ctx.session };
}

/** Own session, root, the operator of the session's agent, or an admin of the session's tenant (spec 6.5, 6.6). */
async function mayRevoke(ctx: Ctx, target: Session): Promise<boolean> {
  const me = ctx.identity!;
  if (target.identity_id === me.id || me.is_root === 1) return true;
  if (me.kind !== "human") return false;
  const owner = await getIdentityById(ctx.db, target.identity_id);
  if (target.tenant_id === null) return false;
  const role = await roleIn(ctx, target.tenant_id);
  if (owner && owner.kind === "agent" && owner.operator_id === me.id && rank(role) >= rank("member")) return true;
  // Tenant admins revoke agent runs and assistant grants in their tenant (spec 6.6, MCP spec 10.2), never browser sessions.
  return (target.kind === "agent_run" || target.kind === "oauth") && rank(role) >= rank("admin");
}

export const sessionList = defineVerb({
  name: "session.list", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null, summary: "List your active sessions.",
  parse: () => ({}),
  run: async (ctx) => {
    const { identity, session } = requireIdentity(ctx);
    const rows = await listSessions(ctx.db, identity.id, ctx.now);
    return {
      sessions: rows.map((s) => ({
        id: s.id, kind: s.kind, label: s.label, created_at: s.created_at, last_seen_at: s.last_seen_at,
        expires_at: s.expires_at, last_proof_at: s.last_proof_at, current: s.id === session.id,
      })),
    };
  },
});

export const sessionRevoke = defineVerb({
  name: "session.revoke", kind: "command", scope: "public", minRole: "public", freshProofMinutes: null, summary: "Revoke a session: your own, a run of an agent you operate, or (admins) any run in your tenant; roots any session.",
  parse: (i) => ({ session_id: reqString(i, "session_id", { max: 26 }) }),
  run: async (ctx, p) => {
    const { identity, session } = requireIdentity(ctx);
    const target = await getSessionById(ctx.db, p.session_id);
    if (!target || !(await mayRevoke(ctx, target))) throw notFound("no such session");
    await revokeSession(ctx.db, target.id, ctx.now);
    await recordEvent(ctx.db, { tenant_id: target.tenant_id, identity_id: identity.id, session_id: session.id, kind: "session.revoke", target_kind: "session", target_id: target.id, summary: `Revoked session ${target.id}` }, ctx.now);
    // An oauth session is an assistant grant: revoking one revokes the other (MCP spec 10.2).
    if (target.kind === "oauth") {
      const grant = await getGrantBySessionId(ctx.db, target.id);
      if (grant) await revokeOAuthGrant(ctx.env, grant, { identity_id: identity.id, session_id: session.id }, target.identity_id === identity.id ? "user" : "admin", ctx.now);
    }
    return { ok: true };
  },
});

export const sessionEnd = defineVerb({
  name: "session.end", kind: "command", scope: "public", minRole: "public", freshProofMinutes: null, summary: "Sign out: revoke the current session.",
  parse: () => ({}),
  run: async (ctx) => {
    const { identity, session } = requireIdentity(ctx);
    await revokeSession(ctx.db, session.id, ctx.now);
    await recordEvent(ctx.db, { tenant_id: null, identity_id: identity.id, session_id: session.id, kind: "session.end", target_kind: "session", target_id: session.id, summary: "Signed out" }, ctx.now);
    ctx.staleCookie = ctx.authKind === "cookie";
    return { ok: true };
  },
});

export const sessionStart = defineVerb({
  name: "session.start", kind: "command", scope: "tenant", minRole: "reader", freshProofMinutes: null, longLivedToken: true,
  summary: "Start an agent run: trade a long-lived pmw_ token for a pms_ session token pinned to this tenant (ttl in seconds, default 1 day, max 7).",
  parse: (i) => ({ label: reqString(i, "label", { max: 80 }).trim(), ttl: optInt(i, "ttl", { min: 60, max: AGENT_SESSION_MAX_TTL_S }) }),
  run: async (ctx, p) => {
    if (ctx.authKind !== "token" || !ctx.apiToken || !ctx.identity) throw forbidden("session.start needs a long-lived pmw_ token");
    if (!p.label) throw badRequest("label is required");
    const { session, token } = await createAgentSession(ctx.db, {
      identity_id: ctx.identity.id, tenant_id: ctx.apiToken.tenant_id, label: p.label, parent_token_id: ctx.apiToken.id,
      ttl_s: p.ttl ?? AGENT_SESSION_DEFAULT_TTL_S,
    }, ctx.now);
    await markApiTokenUsed(ctx.db, ctx.apiToken.id, ctx.now);
    await recordEvent(ctx.db, {
      tenant_id: ctx.apiToken.tenant_id, identity_id: ctx.identity.id, session_id: session.id, kind: "session.start", target_kind: "session", target_id: session.id,
      summary: `Started run "${p.label}" with token "${ctx.apiToken.name}"`,
    }, ctx.now);
    return { session_id: session.id, session_token: token, expires_at: session.expires_at, tenant: ctx.tenant!.slug };
  },
});

type GitCredential = { session_id: string; token: string; username: string; tenant: string; expires_at: number; clone_example: string };

export const sessionGit = defineVerb({
  name: "session.git", kind: "command", scope: "public", minRole: "public", freshProofMinutes: 60, humanOnly: true,
  summary: "Mint a git credential: a pms_ token for one tenant's git host, valid 90 days, usable nowhere else. Shown once.",
  parse: (i) => ({ tenant: optString(i, "tenant", { max: 63 }), label: reqString(i, "label", { max: 80 }).trim() }),
  run: async (ctx, p): Promise<GitCredential> => {
    const { identity, session } = requireHuman(ctx);
    if (!p.label) throw badRequest("label is required");
    const { tenant } = await targetTenant(ctx, p.tenant);
    const git = await createGitSession(ctx.db, { identity_id: identity.id, tenant_id: tenant.id, label: p.label }, ctx.now);
    await recordEvent(ctx.db, {
      tenant_id: tenant.id, identity_id: identity.id, session_id: session.id, kind: "session.git", target_kind: "session", target_id: git.session.id,
      summary: `Created git credential "${p.label}"`,
    }, ctx.now);
    return {
      session_id: git.session.id, token: git.token, username: identity.email, tenant: tenant.slug, expires_at: git.session.expires_at,
      clone_example: `git clone https://${tenant.slug}.${ctx.env.HUB_DOMAIN.toLowerCase()}/<repo>.git`,
    };
  },
  renderForm: (r: GitCredential) => `<h1>New git credential for ${esc(r.tenant)}</h1>
<p>Copy the password now: it will not be shown again. It works only for git on ${esc(r.tenant)} and expires in 90 days.</p>
<p>Username: <code>${esc(r.username)}</code></p>
<p>Password:</p>
<pre>${esc(r.token)}</pre>
<p>Try it: <code>${esc(r.clone_example)}</code>. Revoke it under Sessions on <a href="/me">your account</a>.</p>`,
});
