// Headless agents (owner, 2026-10-08). Agents run on machines with no browser, so they can't do the OAuth dance. A
// person creates the agent in Pimwell and gets a one-time connect link, valid 24 hours, to paste to it. The agent
// claims the link with a POST and gets its own long-lived token for /agent/mcp, plus the exact client setup.
// - A GET only explains, so link previews in chat apps can't use a link up.
// - A claim is one atomic update: two claims can't both succeed.
// - Only the link's hash is stored, and request logs show /connect/:token.
import type { Env } from "../env";
import type { Tenant } from "../db/types";
import { randomToken, sha256Hex, ulid } from "../ids";
import { createApiToken } from "../db/apiTokens";
import { getAgentById } from "../db/agents";
import { agentCredentialOk } from "./agent";
import { takeRateDetail } from "../rate";
import { note } from "../log";

export const CONNECT_LINK_TTL_MS = 24 * 3600 * 1000;
export const AGENT_TOKEN_TTL_DAYS = 90;
const LINK_PREFIX = "pmc_";

/**
 * The names an agent uses for this connection, always prefixed with pimwell and the organization, so they never collide
 * with its other MCP servers and keys, or with another Pimwell organization it also works in.
 */
export function connectionNames(tenantSlug: string): { server: string; secret: string; file: string } {
  return { server: `pimwell-${tenantSlug}`, secret: `PIMWELL_${tenantSlug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`, file: `pimwell-${tenantSlug}-connect.json` };
}

export const agentMcpUrl = (env: Env, tenantSlug: string) => `https://${tenantSlug}.${env.HUB_DOMAIN.toLowerCase()}/agent/mcp`;

export async function createConnectLink(
  env: Env, input: { tenant: Tenant; agent_id: string; created_by: string }, now: number,
): Promise<{ id: string; link: string; expires_at: number }> {
  const token = randomToken(LINK_PREFIX);
  const id = ulid(now);
  const expires_at = now + CONNECT_LINK_TTL_MS;
  await env.HUB_DB.prepare("INSERT INTO agent_connect_link (id, tenant_id, agent_id, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.tenant.id, input.agent_id, await sha256Hex(token), input.created_by, now, expires_at).run();
  return { id, link: `https://${input.tenant.slug}.${env.HUB_DOMAIN.toLowerCase()}/connect/${token}`, expires_at };
}

const text = (body: string, status = 200, extra: Record<string, string> = {}) => new Response(body, {
  status, headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...extra },
});

/** GET: what this link is and how to use it. It never reads or spends the link. */
export function connectInstructions(request: Request): Response {
  const url = new URL(request.url);
  const n = connectionNames(url.hostname.split(".")[0]!);
  return text(`# Pimwell connect link

This link connects one AI agent to Pimwell. It works once, within 24 hours of being made.

- **If you are the agent:** claim it with an HTTP POST from your own process (curl, or your HTTP tool), never through a browser: the answer carries your token once, and a browser can drop it. For the token as JSON, straight into a private file:
  \`umask 077; curl -sf -X POST -H 'accept: application/json' '${url.origin}${url.pathname}' > ${n.file}\`
  Without that header the answer is these instructions in Markdown, with the token and the exact command for your client.
- **The whole procedure**, ready to save as a skill: ${url.origin}/skills/pimwell-agent-onboarding/SKILL.md
- **If you are a person:** paste this link to your agent. Don't open it anywhere else.

**Names to use**, so nothing collides with your other MCP servers and keys: MCP server \`${n.server}\`, secret or environment variable \`${n.secret}\`. Never a generic name such as MCP_API_KEY.
`);
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** POST: claim the link. One atomic update decides it; everything after runs only for the one winner. */
export async function claimConnectLink(request: Request, env: Env, tenantSlug: string, token: string, now: number = Date.now(), waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  note(request, { tenant: tenantSlug, via: "connect" });
  const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
  const jsonOut = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", ...extra } });
  const gone = wantsJson ? jsonOut({ ok: false, error: "gone", detail: "This link was already used, expired (links last 24 hours), or isn't a Pimwell connect link. Ask your person for a new one: People and agents, then the agent's page, then Make connect link." }, 410) : text(`# This link can't be used

It was already used, it expired (links last 24 hours), or it isn't a Pimwell connect link. Ask your person for a new one: in Pimwell, People and agents → Connect an agent.
`, 410);
  try {
    const r = await takeRateDetail(env.RATE, "connect_ip", ip, now, waitUntil);
    if (!r.ok) return wantsJson ? jsonOut({ ok: false, error: "too_many_requests" }, 429, { "retry-after": String(r.retryAfterS) }) : text("Too many attempts. Try again later.\n", 429, { "retry-after": String(r.retryAfterS) });
  } catch (e) {
    console.log("connect rate failed", e instanceof Error ? e.name : "error");
  }
  if (!token.startsWith(LINK_PREFIX) || token.length > 100) return gone;
  const link = await env.HUB_DB.prepare(`UPDATE agent_connect_link SET claimed_at = ?, claimed_ip = ?
      WHERE token_hash = ? AND claimed_at IS NULL AND expires_at > ? AND tenant_id = (SELECT id FROM tenant WHERE slug = ? AND state = 'active')
      RETURNING id, tenant_id, agent_id, created_by`)
    .bind(now, ip.slice(0, 64), await sha256Hex(token), now, tenantSlug).first<{ id: string; tenant_id: string; agent_id: string; created_by: string }>();
  if (!link) return gone;
  const agent = await getAgentById(env.HUB_DB, link.agent_id);
  if (!agent || agent.tenant.id !== link.tenant_id || !(await agentCredentialOk(env.HUB_DB, agent.identity, link.tenant_id, null))) return gone;
  await env.HUB_DB.prepare(`UPDATE api_token SET revoked_at = ? WHERE identity_id = ? AND revoked_at IS NULL AND last_used_at IS NULL
      AND id IN (SELECT api_token_id FROM agent_connect_link WHERE agent_id = ? AND api_token_id IS NOT NULL)`).bind(now, agent.identity.id, agent.identity.id).run();
  const expires_at = now + AGENT_TOKEN_TTL_DAYS * 86_400_000;
  const { token: t, plaintext } = await createApiToken(env.HUB_DB, {
    identity_id: agent.identity.id, tenant_id: link.tenant_id, name: `Connected ${day(now)}`, created_by: link.created_by, expires_at,
  }, now);
  await env.HUB_DB.batch([
    env.HUB_DB.prepare("UPDATE agent_connect_link SET api_token_id = ? WHERE id = ?").bind(t.id, link.id),
    env.HUB_DB.prepare(`INSERT INTO event (id, tenant_id, identity_id, session_id, kind, target_kind, target_id, summary, created_at) VALUES (?, ?, ?, NULL, 'agent.connect', 'api_token', ?, ?, ?)`)
      .bind(ulid(now), link.tenant_id, agent.identity.id, t.id, `Agent ${agent.identity.email} connected with a link`, now),
  ]);
  const mcp = agentMcpUrl(env, agent.tenant.slug);
  const hub = env.HUB_DOMAIN.toLowerCase();
  const n = connectionNames(agent.tenant.slug);
  if (wantsJson) {
    return jsonOut({
      ok: true, token: plaintext, token_expires_at: new Date(expires_at).toISOString(), mcp_url: mcp, header: "Authorization: Bearer <token>",
      names: { mcp_server: n.server, secret: n.secret, why: "Prefixed with pimwell and the organization so they never collide with your other MCP servers or keys. Use exactly these." },
      agent: { name: agent.identity.display_name, address: agent.identity.email }, organization: agent.tenant.display_name,
      clients: {
        claude_code: `claude mcp add --transport http ${n.server} ${mcp} --header "Authorization: Bearer $${n.secret}"`,
        codex: `[mcp_servers.${n.server}] url = "${mcp}", bearer_token_env_var = "${n.secret}"`,
        other: "a remote streamable HTTP MCP server with this URL and header",
      },
      skill: `https://${agent.tenant.slug}.${hub}/skills/pimwell-agent-onboarding/SKILL.md`,
      next: [`Store the token as ${n.secret}, only in your MCP client's configuration or a private secret file (mode 0600), and delete the claim file.`, "Call whoami to check.", `Call skill_read with onboard and continue from step 2 (also at https://${hub}/setup).`, "Tell your person you're connected, and as whom."],
    });
  }
  return text(`# Connected to Pimwell

You are **${agent.identity.display_name}** (\`${agent.identity.email}\`) in the organization **${agent.tenant.display_name}**. You answer to the person who made this link, and you can do what they can, up to a member's rights.

**Your token**, shown once: \`${plaintext}\`
- It expires on ${day(expires_at)}. Then ask your person for a new connect link.
- Keep it only in your MCP client's configuration. Never put it in a repository, a message, a log or a work item.

**Names to use**, so nothing collides with your other MCP servers and keys: server \`${n.server}\`, secret \`${n.secret}\`. Never a generic name such as MCP_API_KEY.

**MCP server:** \`${mcp}\`, streamable HTTP, with the header \`Authorization: Bearer <token>\`. It has no browser sign-in.

**Add it to your client:**
- **Claude Code:** \`claude mcp add --transport http ${n.server} ${mcp} --header "Authorization: Bearer ${plaintext}"\`
- **Codex:** in \`~/.codex/config.toml\`, add a \`[mcp_servers.${n.server}]\` table with \`url = "${mcp}"\` and \`bearer_token_env_var = "${n.secret}"\`. Then set \`${n.secret}\` to the token in the environment Codex runs in.
- **Any other MCP client:** add a remote streamable HTTP server with that URL and header.

**Then** (the whole procedure, ready to save as a skill: https://${agent.tenant.slug}.${hub}/skills/pimwell-agent-onboarding/SKILL.md):
1. Call \`whoami\` to check the connection.
2. Call \`skill_read\` with \`onboard\`, and continue from step 2 there. The same text is at https://${hub}/setup.
3. Tell your person you're connected, and as whom.
`);
}
