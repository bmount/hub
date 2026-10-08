// /agent/mcp: the MCP server for headless agents, authenticated by the agent's own long-lived pmw_ token (from a
// connect link, src/auth/connect.ts). /mcp stays OAuth-only for people's assistants.
// - The agent's rights are its own role, capped at member and at its operator's current role, under the same
//   exposure rules as an assistant connection with read and write.
// - Each call runs under one reused agent_run session, so every action is on the record as the agent.
// - Lookups take one D1 batch; the session is reused until it is an hour from expiry.
import type { Env } from "../env";
import type { ApiToken, Identity, Membership, Role, Session, Tenant } from "../db/types";
import { rank, roleFor, type Ctx } from "../auth/context";
import { createAgentSession, touchSession } from "../db/sessions";
import { recordEvent } from "../db/events";
import { seal } from "../models/secretbox";
import { sha256Hex } from "../ids";
import { takeRateDetail, takeRatesAtomic } from "../rate";
import { oauthJson } from "../http/oauthMeta";
import { API_TOKEN_PREFIX } from "../db/apiTokens";

export const AGENT_MCP_SCOPES = ["read", "write"];
const SESSION_TTL_S = 24 * 3600;
const SESSION_REUSE_MARGIN_MS = 3600 * 1000;

export type AgentMcpAuth =
  | { kind: "ok"; ctx: Ctx; token: string; expiresAt: number }
  | { kind: "deny"; response: Response };

const deny = (status: number, error: string, detail: string, extra: Record<string, string> = {}): AgentMcpAuth =>
  ({ kind: "deny", response: oauthJson({ error, detail }, status, extra) });

/** No OAuth discovery here: a client that saw resource metadata would try a browser sign-in the agent can't do. */
const refused = () => deny(401, "invalid_token", "This server takes an agent token from a Pimwell connect link. Ask your person for a new link (People and agents → Connect an agent).",
  { "www-authenticate": 'Bearer error="invalid_token"' });

type OperatorRow = { kind: string; state: string; is_root: number; role: Role | null; mstate: string | null };
type SessionRow = Session & { ciphertext: string; iv: string };

export async function agentMcpAuth(request: Request, env: Env, slug: string, now: number, waitUntil?: (p: Promise<unknown>) => void): Promise<AgentMcpAuth> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const refuse = async (): Promise<AgentMcpAuth> => {
    try {
      const r = await takeRateDetail(env.RATE, "mcp_anon_ip", ip, now, waitUntil);
      if (!r.ok) return deny(429, "too_many_requests", "slow down", { "retry-after": String(r.retryAfterS) });
    } catch (e) {
      console.log("anon rate failed", e instanceof Error ? e.name : "error");
    }
    return refused();
  };
  if (!token.startsWith(API_TOKEN_PREFIX) || token.length > 200) return refuse();
  const hash = await sha256Hex(token);
  const db = env.HUB_DB;
  const [tokR, idR, tenR, memR, opR, sesR] = await db.batch([
    db.prepare("SELECT * FROM api_token WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)").bind(hash, now),
    db.prepare("SELECT i.* FROM identity i JOIN api_token a ON a.identity_id = i.id WHERE a.token_hash = ?").bind(hash),
    db.prepare("SELECT * FROM tenant WHERE slug = ?").bind(slug),
    db.prepare("SELECT m.* FROM membership m JOIN api_token a ON a.identity_id = m.identity_id AND a.tenant_id = m.tenant_id WHERE a.token_hash = ?").bind(hash),
    db.prepare(`SELECT op.kind, op.state, op.is_root, om.role, om.state AS mstate FROM api_token a JOIN identity ag ON ag.id = a.identity_id
      JOIN identity op ON op.id = ag.operator_id LEFT JOIN membership om ON om.identity_id = op.id AND om.tenant_id = a.tenant_id WHERE a.token_hash = ?`).bind(hash),
    db.prepare(`SELECT s.*, x.ciphertext, x.iv FROM agent_mcp_session x JOIN session s ON s.id = x.session_id JOIN api_token a ON a.id = x.api_token_id
      WHERE a.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? ORDER BY s.expires_at DESC LIMIT 1`).bind(hash, now + SESSION_REUSE_MARGIN_MS),
  ]);
  const apiToken = tokR!.results[0] as ApiToken | undefined;
  const identity = idR!.results[0] as Identity | undefined;
  const tenant = tenR!.results[0] as Tenant | undefined;
  const membership = memR!.results[0] as Membership | undefined;
  const op = opR!.results[0] as OperatorRow | undefined;
  if (!apiToken || !identity || !tenant || !membership || !op) return refuse();
  if (identity.kind !== "agent" || identity.state !== "active" || tenant.state !== "active" || apiToken.tenant_id !== tenant.id || membership.state !== "active") return refuse();
  // The operator must still be here: an agent never outlives its person's access.
  if (op.kind !== "human" || op.state !== "active" || (op.is_root !== 1 && op.mstate !== "active")) return refuse();
  const opRole: Role | null = op.is_root === 1 ? "root" : op.role;
  const own = roleFor(identity, membership);
  let role: Role | null = rank(own) <= rank(opRole) ? own : opRole;
  if (rank(role) > rank("member")) role = "member";

  for (const r of await takeRatesAtomic(db, ["agent_mcp_minute", "agent_mcp_hour"], apiToken.id, now, waitUntil)) {
    if (r.ok) continue;
    if (r.first) {
      await recordEvent(db, { tenant_id: tenant.id, identity_id: identity.id, session_id: null, kind: "mcp.denied", target_kind: "api_token", target_id: apiToken.id,
        summary: `Rate limit ${r.bucket} reached for agent ${identity.email}` }, now);
    }
    return deny(429, "too_many_requests", "slow down", { "retry-after": String(r.retryAfterS) });
  }

  let session: Session;
  let sealed: { ciphertext: string; iv: string };
  const reuse = sesR!.results[0] as SessionRow | undefined;
  if (reuse) {
    const { ciphertext, iv, ...s } = reuse;
    session = await touchSession(db, s, now);
    sealed = { ciphertext, iv };
  } else {
    const made = await createAgentSession(db, { identity_id: identity.id, tenant_id: tenant.id, label: "agent mcp", parent_token_id: apiToken.id, ttl_s: SESSION_TTL_S }, now);
    sealed = await seal(env.HUB_SECRETS_KEY, made.token);
    await db.batch([
      db.prepare("INSERT INTO agent_mcp_session (session_id, tenant_id, api_token_id, ciphertext, iv) VALUES (?, ?, ?, ?, ?)").bind(made.session.id, tenant.id, apiToken.id, sealed.ciphertext, sealed.iv),
      db.prepare("UPDATE api_token SET last_used_at = ? WHERE id = ?").bind(now, apiToken.id),
    ]);
    session = made.session;
  }
  const ctx: Ctx = {
    env, db, now, ip, waitUntil, host: { kind: "tenant", slug: tenant.slug }, tenant, identity, session, apiToken: null, role,
    authKind: "bearer", staleCookie: false, agentMcp: { token_id: apiToken.id, scopes: [...AGENT_MCP_SCOPES], sealed },
  };
  return { kind: "ok", ctx, token, expiresAt: Math.floor(session.expires_at / 1000) };
}
