import { defineVerb } from "./table";
import { optInt, optString, reqString } from "./params";
import { badRequest, conflict, HubError, notFound } from "../errors";
import { getAgentById } from "../db/agents";
import {
  createApiToken, getApiTokenById, listApiTokensForIdentity, listApiTokensForOperator, listApiTokensForTenant, revokeApiToken,
} from "../db/apiTokens";
import { recordEvent } from "../db/events";
import { rank } from "../auth/context";
import { manageableAgent, requireHuman } from "../auth/authority";
import { esc } from "../html";
import type { ApiToken } from "../db/types";

export function tokenView(t: ApiToken) {
  return {
    id: t.id, name: t.name, agent_id: t.identity_id, tenant_id: t.tenant_id, created_by: t.created_by,
    created_at: t.created_at, expires_at: t.expires_at, last_used_at: t.last_used_at,
  };
}

type Created = { token: string; token_id: string; name: string; agent_id: string; agent: string; tenant: string; expires_at: number | null; start_url: string };

export const tokenCreate = defineVerb({
  name: "token.create", kind: "command", scope: "public", minRole: "public", freshProofMinutes: 60, humanOnly: true,
  summary: "Mint a long-lived pmw_ token for an agent you operate (admins: any agent in the tenant). The token is shown once.",
  parse: (i) => ({
    agent_id: reqString(i, "agent_id", { max: 26 }),
    name: reqString(i, "name", { max: 80 }),
    expires_in_days: optInt(i, "expires_in_days", { min: 1, max: 365 }),
  }),
  run: async (ctx, p): Promise<Created> => {
    const { identity, session } = requireHuman(ctx);
    const agent = await manageableAgent(ctx, await getAgentById(ctx.db, p.agent_id));
    if (agent.identity.state !== "active") throw conflict("agent is archived");
    const name = p.name.trim();
    if (!name) throw badRequest("name is required");
    const expires_at = p.expires_in_days === null ? null : ctx.now + p.expires_in_days * 86_400_000;
    const { token, plaintext } = await createApiToken(ctx.db, {
      identity_id: agent.identity.id, tenant_id: agent.tenant.id, name, created_by: identity.id, expires_at,
    }, ctx.now);
    await recordEvent(ctx.db, {
      tenant_id: agent.tenant.id, identity_id: identity.id, session_id: session.id, kind: "token.create", target_kind: "api_token", target_id: token.id,
      summary: `Created token "${token.name}" for ${agent.identity.email}`,
    }, ctx.now);
    return { token: plaintext, token_id: token.id, name: token.name, agent_id: agent.identity.id, agent: agent.identity.email, tenant: agent.tenant.slug, expires_at,
      start_url: `https://${agent.tenant.slug}.${ctx.env.HUB_DOMAIN.toLowerCase()}/api/session.start` };
  },
  renderForm: (r: Created) => `<h1>New token for ${esc(r.agent)}</h1>
<p>Token <strong>${esc(r.name)}</strong>. Copy it now: it will not be shown again.</p>
<pre>${esc(r.token)}</pre>
<p>Start a run with <code>POST ${esc(r.start_url)}</code> and <code>Authorization: Bearer &lt;token&gt;</code>.</p>
<p><a href="/me">Back</a></p>`,
});

export const tokenRevoke = defineVerb({
  name: "token.revoke", kind: "command", scope: "public", minRole: "public", freshProofMinutes: 60, humanOnly: true,
  summary: "Revoke a long-lived token and every session it started.",
  parse: (i) => ({ token_id: reqString(i, "token_id", { max: 26 }) }),
  run: async (ctx, p) => {
    const { identity, session } = requireHuman(ctx);
    const t = await getApiTokenById(ctx.db, p.token_id);
    if (!t) throw notFound("no such token");
    try {
      await manageableAgent(ctx, await getAgentById(ctx.db, t.identity_id));
    } catch (e) {
      if (e instanceof HubError && e.status === 404) throw notFound("no such token");
      throw e;
    }
    if (t.revoked_at !== null) throw conflict("token already revoked");
    const r = await revokeApiToken(ctx.db, t.id, ctx.now);
    if (!r.revoked) throw conflict("token already revoked");
    await recordEvent(ctx.db, {
      tenant_id: t.tenant_id, identity_id: identity.id, session_id: session.id, kind: "token.revoke", target_kind: "api_token", target_id: t.id,
      summary: `Revoked token "${t.name}"; ended ${r.sessions} session(s)`,
    }, ctx.now);
    return { ok: true, sessions_revoked: r.sessions };
  },
});

export const tokenList = defineVerb({
  name: "token.list", kind: "query", scope: "public", minRole: "public", freshProofMinutes: null, humanOnly: true,
  summary: "List live long-lived tokens: one agent's, your agents', or (admins on a tenant host) the tenant's.",
  parse: (i) => ({ agent_id: optString(i, "agent_id", { max: 26 }) }),
  run: async (ctx, p) => {
    const { identity } = requireHuman(ctx);
    let rows: ApiToken[];
    if (p.agent_id) {
      const agent = await manageableAgent(ctx, await getAgentById(ctx.db, p.agent_id));
      rows = await listApiTokensForIdentity(ctx.db, agent.identity.id, ctx.now);
    } else if (ctx.tenant && rank(ctx.role) >= rank("admin")) {
      rows = await listApiTokensForTenant(ctx.db, ctx.tenant.id, ctx.now);
    } else {
      rows = (await listApiTokensForOperator(ctx.db, identity.id, ctx.now)).map((x) => x.token);
    }
    return { tokens: rows.map(tokenView) };
  },
});
