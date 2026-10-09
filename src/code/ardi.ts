// The hub's connection to Ardi, the git host (audit 2026-10-07). Repositories live in Ardi's Durable Objects, which
// nothing else can bind, so the hub reads through Ardi's JSON API (`POST /t/<org>/api/<verb>`) over the ARDI service
// binding. Ardi accepts only git or agent-run sessions, so:
//   - an agent calling through the hub uses its own run token;
//   - a person gets a git session the hub mints for them in that organization and keeps sealed (ardi_cred);
//   - push sync uses a reader "pimwell-sync" agent per organization, with a fresh one-hour run session per sync.
import type { Env } from "../env";
import type { Ctx } from "../auth/context";
import { HubError } from "../errors";
import { open, seal } from "../models/secretbox";
import { createGitSession, createRepoCreateSession, revokeSession } from "../db/sessions";

const TIMEOUT_MS = 10_000;
const REFRESH_MS = 7 * 86_400_000;           // mint a new git session when the sealed one has less than a week left

export type ArdiPage<T> = { result: T; next: string | null };

let testArdi: Fetcher | null = null;
/** Tests only: stand in for the git host. */
export function setArdiForTest(f: Fetcher | null): void { testArdi = f; }

/** One Ardi verb. Throws HubError with Ardi's reason, or 503 when Ardi can't be reached. */
export async function ardiCall<T>(env: Env, org: string, authorization: string, verb: string, body: Record<string, unknown>): Promise<ArdiPage<T>> {
  const ardi = testArdi ?? env.ARDI;
  if (!ardi) throw new HubError(503, "unavailable", "the git host is not connected");
  let res: Response;
  try {
    res = await ardi.fetch(`https://ardi.internal/t/${encodeURIComponent(org)}/api/${verb}`, {
      method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HubError(503, "unavailable", "the git host did not answer");
  }
  const j = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; next?: string | null; error?: string | { message?: string; reason?: string }; detail?: string } | null;
  if (!res.ok || !j || j.ok !== true) {
    const why = typeof j?.error === "string" ? j.error : j?.error?.message ?? j?.detail ?? `git host answered ${res.status}`;
    throw new HubError(res.status === 404 ? 404 : res.status === 401 || res.status === 403 ? 403 : 502, res.status === 404 ? "not_found" : "unavailable", String(why).slice(0, 200));
  }
  return { result: j.result as T, next: j.next ?? null };
}

const basic = (user: string, token: string) => `Basic ${btoa(`${user}:${token}`)}`;

/** The credential for reading code as this caller. */
export async function codeAuth(ctx: Ctx): Promise<string> {
  const id = ctx.identity;
  if (!id || !ctx.tenant) throw new HubError(401, "unauthorized");
  if (id.kind === "agent") {
    if (ctx.authKind === "bearer" && ctx.bearerToken && ctx.session?.kind === "agent_run") return basic("agent", ctx.bearerToken);
    if (ctx.agentMcp && ctx.session?.kind === "agent_run") return basic("agent", await open(ctx.env.HUB_SECRETS_KEY, ctx.agentMcp.sealed));
    throw new HubError(403, "forbidden", "agents read code with their run session");
  }
  const row = await ctx.db.prepare("SELECT ciphertext, iv, expires_at FROM ardi_cred WHERE identity_id = ? AND tenant_id = ? AND kind = 'git_session'")
    .bind(id.id, ctx.tenant.id).first<{ ciphertext: string; iv: string; expires_at: number | null }>();
  if (row && (row.expires_at ?? 0) - ctx.now > REFRESH_MS) {
    const live = await ctx.db.prepare("SELECT 1 FROM session s JOIN ardi_cred c ON c.ref_id = s.id WHERE c.identity_id = ? AND c.tenant_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?")
      .bind(id.id, ctx.tenant.id, ctx.now).first();
    if (live) return basic(id.email, await open(ctx.env.HUB_SECRETS_KEY, row));
  }
  const { session, token } = await createGitSession(ctx.db, { identity_id: id.id, tenant_id: ctx.tenant.id, label: "Pimwell code views" }, ctx.now);
  const sealed = await seal(ctx.env.HUB_SECRETS_KEY, token);
  await ctx.db.prepare(`INSERT INTO ardi_cred (identity_id, tenant_id, kind, ref_id, ciphertext, iv, expires_at, created_at) VALUES (?, ?, 'git_session', ?, ?, ?, ?, ?)
    ON CONFLICT (identity_id, tenant_id) DO UPDATE SET kind = excluded.kind, ref_id = excluded.ref_id, ciphertext = excluded.ciphertext, iv = excluded.iv, expires_at = excluded.expires_at, created_at = excluded.created_at`)
    .bind(id.id, ctx.tenant.id, session.id, sealed.ciphertext, sealed.iv, session.expires_at, ctx.now).run();
  return basic(id.email, token);
}

/** Read code as this caller: the repository is the project's slug. */
export async function codeRead<T>(ctx: Ctx, verb: string, body: Record<string, unknown>): Promise<ArdiPage<T>> {
  return ardiCall<T>(ctx.env, ctx.tenant!.slug, await codeAuth(ctx), verb, body);
}

/**
 * Create the repository for a repo project, as the person or agent who made the project. The git host lets only admins
 * create repositories, so the hub spends a one-shot session (createRepoCreateSession) on this one call. A repository that
 * already exists is fine: it is the project's.
 */
export async function createRepo(env: Env, db: D1Database, input: { identity_id: string; tenant_id: string; org: string; name: string }, now: number): Promise<void> {
  const { session, token } = await createRepoCreateSession(db, { identity_id: input.identity_id, tenant_id: input.tenant_id }, now);
  try {
    await ardiCall(env, input.org, basic("pimwell", token), "repo.create", { name: input.name });
  } catch (e) {
    if (!(e instanceof HubError && e.status === 502 && /already exists/.test(e.message))) throw e;
  } finally {
    await revokeSession(db, session.id, now);
  }
}

// ---------- Shapes of what Ardi returns (the fields the hub uses) ----------

export type ArdiRef = { name: string; target: string };
export type ArdiCommit = {
  oid: string; tree: string; parents: string[]; author_name: string; author_email: string; author_time: number;
  committer_name: string; committer_email: string; commit_time: number; summary: string; message?: string;
  principal: string | null; session: string | null; trailer_principal: string | null; trailer_session: string | null;
};
export type ArdiChange = { path: string; prev_path: string | null; prev_blob: string | null; new_blob: string | null; kind: string };
export type ArdiEntry = { kind: "blob" | "tree" | "commit"; mode: string; name: string; oid: string };
export type ArdiEvent = { id: number; kind: string; principal: string | null; session: string | null; ref: string | null; target: string | null; summary: string | null; time: number };

export const OID_RE = /^[0-9a-f]{40}$/;
export const REF_RE = /^(HEAD|refs\/(heads|tags)\/[\w./-]{1,200}|[0-9a-f]{40})$/;
