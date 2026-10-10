import { defineVerb } from "./table";
import { optString, reqString } from "./params";
import { badRequest, conflict, forbidden, HubError } from "../errors";
import { COPY_SCRIPT, esc } from "../html";
import { agentMcpUrl, connectionNames, createConnectLink } from "../auth/connect";
import { archiveAgent, createAgent, getAgentById } from "../db/agents";
import { getIdentityByEmail, normalizeEmail } from "../db/identities";
import { getMembership } from "../db/memberships";
import { recordEvent } from "../db/events";
import { rank, roleFor } from "../auth/context";
import { manageableAgent, requireHuman, targetTenant } from "../auth/authority";
import type { Agent } from "../db/types";

export function agentView(a: Agent) {
  return {
    id: a.identity.id, slug: a.slug, address: a.identity.email, display_name: a.identity.display_name, tenant: a.tenant.slug,
    role: a.membership.role, operator_id: a.identity.operator_id, state: a.identity.state, created_at: a.identity.created_at,
  };
}

function agentRole(i: Record<string, unknown>): "member" | "reader" {
  const v = optString(i, "role", { max: 10 }) ?? "member";
  if (v !== "member" && v !== "reader") throw badRequest("role must be one of member, reader");
  return v;
}

export const agentCreate = defineVerb({
  name: "agent.create", kind: "command", scope: "public", minRole: "public", freshProofMinutes: 60, humanOnly: true,
  summary: "Create an agent in an organization with the address <org>.<name>@pimwell.com. You operate it unless an admin names another member.",
  parse: (i) => ({
    tenant: optString(i, "tenant", { max: 63 }),
    slug: reqString(i, "slug", { max: 63 }),
    display_name: reqString(i, "display_name", { max: 80 }),
    operator: optString(i, "operator", { max: 254 }),
    role: agentRole(i),
  }),
  run: async (ctx, p) => {
    const { identity, session } = requireHuman(ctx);
    const { tenant, role } = await targetTenant(ctx, p.tenant);
    if (rank(role) < rank("member")) throw forbidden("readers may not create agents");
    let operator = identity;
    if (p.operator && normalizeEmail(p.operator) !== identity.email) {
      if (rank(role) < rank("admin")) throw forbidden("only an admin may name another operator");
      const other = await getIdentityByEmail(ctx.db, p.operator);
      const m = other ? await getMembership(ctx.db, other.id, tenant.id) : null;
      if (!other || other.kind !== "human" || rank(roleFor(other, m)) < rank("member")) throw badRequest("operator must be a human member or admin of this tenant");
      operator = other;
    }
    const agent = await createAgent(ctx.db, { tenant, slug: p.slug, display_name: p.display_name, operator_id: operator.id, role: p.role, hubDomain: ctx.env.HUB_DOMAIN }, ctx.now);
    await recordEvent(ctx.db, {
      tenant_id: tenant.id, identity_id: identity.id, session_id: session.id, kind: "agent.create", target_kind: "identity", target_id: agent.identity.id,
      summary: `Created agent ${agent.identity.email} operated by ${operator.email}`,
    }, ctx.now);
    return { agent: agentView(agent) };
  },
});

export const agentArchive = defineVerb({
  name: "agent.archive", kind: "command", scope: "public", minRole: "public", freshProofMinutes: 60, humanOnly: true,
  summary: "Archive an agent you operate (admins: any agent in the tenant). Revokes all its tokens and sessions.",
  parse: (i) => ({ agent_id: reqString(i, "agent_id", { max: 26 }) }),
  run: async (ctx, p) => {
    const { identity, session } = requireHuman(ctx);
    const agent = await manageableAgent(ctx, await getAgentById(ctx.db, p.agent_id));
    if (agent.identity.state !== "active") throw conflict("agent already archived");
    const r = await archiveAgent(ctx.db, agent.identity.id, ctx.now);
    if (!r.archived) throw conflict("agent already archived");
    await recordEvent(ctx.db, {
      tenant_id: agent.tenant.id, identity_id: identity.id, session_id: session.id, kind: "agent.archive", target_kind: "identity", target_id: agent.identity.id,
      summary: `Archived agent ${agent.identity.email}; revoked ${r.tokens} token(s) and ${r.sessions} session(s)`,
    }, ctx.now);
    return { ok: true, tokens_revoked: r.tokens, sessions_revoked: r.sessions };
  },
});

/** A readable agent name from what the person typed: "Build box 2" → "build-box-2". */
export function slugFromName(name: string): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return /^[a-z]/.test(s) ? s : `agent-${s || "1"}`.replace(/-+$/, "");
}

const hubOf = (mcpUrl: string) => new URL(mcpUrl).host.split(".").slice(1).join(".");

type ConnectResult = { agent: ReturnType<typeof agentView>; link: string; expires_at: number; mcp_url: string };

export const agentConnect = defineVerb({
  name: "agent.connect", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: 60, humanOnly: true,
  summary: "Connect a headless agent: creates the agent (it answers to you and can do what you can, up to a member's rights) or takes one you manage, and returns a one-time connect link, valid 24 hours, to paste to it.",
  parse: (i) => ({
    agent_id: optString(i, "agent_id", { max: 26 }),
    display_name: optString(i, "display_name", { max: 80 }),
    slug: optString(i, "slug", { max: 63 }),
  }),
  run: async (ctx, p): Promise<ConnectResult> => {
    const { identity, session } = requireHuman(ctx);
    const tenant = ctx.tenant!;
    let agent: Agent;
    if (p.agent_id) {
      agent = await manageableAgent(ctx, await getAgentById(ctx.db, p.agent_id));
      if (agent.tenant.id !== tenant.id) throw badRequest("that agent belongs to another organization");
      if (agent.identity.state !== "active") throw conflict("agent is archived");
    } else {
      const name = (p.display_name ?? "").trim();
      if (!name) throw badRequest("name the agent");
      const mine = await ctx.db.prepare(`SELECT i.id FROM identity i JOIN membership m ON m.identity_id = i.id AND m.tenant_id = ? AND m.state = 'active'
        WHERE i.kind = 'agent' AND i.state = 'active' AND i.operator_id = ? AND lower(i.display_name) = lower(?) LIMIT 1`).bind(tenant.id, identity.id, name).first<{ id: string }>();
      const existing = mine && !p.slug ? await getAgentById(ctx.db, mine.id) : null;
      // Agents inherit their person's rights (owner, 2026-10-08), never more than a member's.
      const role = rank(ctx.role) >= rank("member") ? "member" : "reader";
      const base = p.slug ? p.slug.trim().toLowerCase() : slugFromName(name);
      let made: Agent | null = existing;
      for (let n = 1; !made; n++) {
        try {
          made = await createAgent(ctx.db, { tenant, slug: n === 1 ? base : `${base}-${n}`, display_name: name, operator_id: identity.id, role, hubDomain: ctx.env.HUB_DOMAIN }, ctx.now);
        } catch (e) {
          if (p.slug || n >= 9 || !(e instanceof HubError) || e.status !== 409) throw e;
        }
      }
      agent = made;
      if (!existing) await recordEvent(ctx.db, {
        tenant_id: tenant.id, identity_id: identity.id, session_id: session.id, kind: "agent.create", target_kind: "identity", target_id: agent.identity.id,
        summary: `Created agent ${agent.identity.email} operated by ${identity.email}`,
      }, ctx.now);
    }
    const link = await createConnectLink(ctx.env, { tenant, agent_id: agent.identity.id, created_by: identity.id }, ctx.now);
    await recordEvent(ctx.db, {
      tenant_id: tenant.id, identity_id: identity.id, session_id: session.id, kind: "agent.connect_link", target_kind: "identity", target_id: agent.identity.id,
      summary: `Made a connect link for ${agent.identity.email}`,
    }, ctx.now);
    return { agent: agentView(agent), link: link.link, expires_at: link.expires_at, mcp_url: agentMcpUrl(ctx.env, tenant.slug) };
  },
  renderForm: (r: ConnectResult) => `<a class="back" href="/people">‹ People</a><h1>Connect ${esc(r.agent.display_name)}</h1>
<p class="lede">Paste this to your agent. It works once, until ${esc(new Date(r.expires_at).toISOString().slice(0, 16).replace("T", " "))} UTC. Copy it now: it won't be shown again.</p>
<pre id="connect-msg">Connect to Pimwell. First save this skill and follow it: https://${esc(r.agent.tenant)}.${esc(hubOf(r.mcp_url))}/skills/pimwell-agent-onboarding/SKILL.md
Your one-time link (claim it with an HTTP POST from your own process, not a browser):
umask 077; curl -sf -X POST -H 'accept: application/json' '${esc(r.link)}' > ${esc(connectionNames(r.agent.tenant).file)}
Name the MCP server ${esc(connectionNames(r.agent.tenant).server)} and the secret ${esc(connectionNames(r.agent.tenant).secret)}, so nothing collides with your other keys.</pre>
<p><button type="button" class="copy" data-copy="#connect-msg">Copy</button></p>${COPY_SCRIPT}
<p>The agent gets its own token for <code>${esc(r.mcp_url)}</code>, as <code>${esc(r.agent.address)}</code>. It answers to you and can do what you can, up to a member's rights. If the link expires or leaks, make a new one from the agent's page; an unclaimed link simply stops working.</p>
<p><a href="/people/${esc(encodeURIComponent(r.agent.address))}">Go to ${esc(r.agent.display_name)}</a></p>`,
});
