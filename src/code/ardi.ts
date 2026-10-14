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
import { artifactRead, artifactReadAuthorized } from "./artifactRead";
import { authorizeGitRepository } from "./gitAccess";
import { ArtifactsRest, artifactNamespace } from "./artifactsRest";
import { repoOwnership } from "./artifactPush";
import { usesArtifacts } from "./gitBackend";

const TIMEOUT_MS = 10_000;
const REFRESH_MS = 7 * 86_400_000;           // mint a new git session when the sealed one has less than a week left

export type ArdiPage<T> = { result: T; next: string | null };

let testArdi: Fetcher | null = null;
/** Tests only: stand in for the git host. */
export function setArdiForTest(f: Fetcher | null): void { testArdi = f; }

/** One Ardi verb. Throws HubError with Ardi's reason, or 503 when Ardi can't be reached. */
export async function ardiCall<T>(env: Env, org: string, authorization: string, verb: string, body: Record<string, unknown>): Promise<ArdiPage<T>> {
  if (String(body.repo ?? "").startsWith("agent-src/") || await usesArtifacts(env, org, String(body.repo ?? ""))) return artifactRead<T>(env, org, authorization, verb, body);
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
  const row = await ctx.db.prepare("/*perf-site:src%2Fcode%2Fardi.ts:58:21:codeAuth:341bdda0*/ SELECT ciphertext, iv, expires_at FROM ardi_cred WHERE identity_id = ? AND tenant_id = ? AND kind = 'git_session'")
    .bind(id.id, ctx.tenant.id).first<{ ciphertext: string; iv: string; expires_at: number | null }>();
  if (row && (row.expires_at ?? 0) - ctx.now > REFRESH_MS) {
    const live = await ctx.db.prepare("/*perf-site:src%2Fcode%2Fardi.ts:61:24:codeAuth:e5b62ded*/ SELECT 1 FROM session s JOIN ardi_cred c ON c.ref_id = s.id WHERE c.identity_id = ? AND c.tenant_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?")
      .bind(id.id, ctx.tenant.id, ctx.now).first();
    if (live) return basic(id.email, await open(ctx.env.HUB_SECRETS_KEY, row));
  }
  const { session, token } = await createGitSession(ctx.db, { identity_id: id.id, tenant_id: ctx.tenant.id, label: "Pimwell code views" }, ctx.now);
  const sealed = await seal(ctx.env.HUB_SECRETS_KEY, token);
  await ctx.db.prepare(`/*perf-site:src%2Fcode%2Fardi.ts:67:9:codeAuth:fc7677af*/ INSERT INTO ardi_cred (identity_id, tenant_id, kind, ref_id, ciphertext, iv, expires_at, created_at) VALUES (?, ?, 'git_session', ?, ?, ?, ?, ?)
    ON CONFLICT (identity_id, tenant_id) DO UPDATE SET kind = excluded.kind, ref_id = excluded.ref_id, ciphertext = excluded.ciphertext, iv = excluded.iv, expires_at = excluded.expires_at, created_at = excluded.created_at`)
    .bind(id.id, ctx.tenant.id, session.id, sealed.ciphertext, sealed.iv, session.expires_at, ctx.now).run();
  return basic(id.email, token);
}

/** Read code as this caller: the repository is the project's slug. */
export async function codeRead<T>(ctx: Ctx, verb: string, body: Record<string, unknown>): Promise<ArdiPage<T>> {
  const repo = String(body.repo ?? "");
  if (verb === "snapshot" && !repo.startsWith("agent-src/") && await usesArtifacts(ctx.env, ctx.tenant!.slug, repo)) {
    const grant = await contextGitGrant(ctx, repo);
    return artifactReadAuthorized<T>(ctx.env, ctx.tenant!.slug, grant, verb, body);
  }
  return ardiCall<T>(ctx.env, ctx.tenant!.slug, await codeAuth(ctx), verb, body);
}

/** buildContext checked the live session, membership and operator for this request. */
async function contextGitGrant(ctx: Ctx, repo: string) {
  if (!ctx.identity || !ctx.session || !ctx.role || (ctx.identity.kind === "agent" &&
    (ctx.session.kind !== "agent_run" || !(ctx.authKind === "bearer" && ctx.bearerToken || ctx.agentMcp))))
    throw new HubError(403, "forbidden", "Git access unavailable");
  const grant = await authorizeGitRepository(ctx.env, { identity: ctx.identity, session: ctx.session, tenant: ctx.tenant!, role: ctx.role }, repo, ctx.now);
  if (!grant) throw new HubError(403, "forbidden", "Git access unavailable");
  return grant;
}

export type RepositoryFile = { entries: ArdiEntry[] } | { content_b64: string; size: number };

/** One authorized Artifacts read; retain the legacy host's directory/file protocol. */
export async function codeFile(ctx: Ctx, repo: string, at: string, path: string): Promise<RepositoryFile> {
  const org = ctx.tenant!.slug;
  if (repo.startsWith("agent-src/"))
    return (await artifactRead<RepositoryFile>(ctx.env, org, await codeAuth(ctx), "file.read", { repo, rev: at, path })).result;
  if (await usesArtifacts(ctx.env, org, repo)) {
    // Do not introspect a second credential (or mint a git session for browser readers).
    const grant = await contextGitGrant(ctx, repo);
    return (await artifactReadAuthorized<RepositoryFile>(ctx.env, org, grant, "file.read", { repo, rev: at, path })).result;
  }
  const auth = await codeAuth(ctx);
  const read = <T>(verb: string, body: Record<string, unknown>) => ardiCall<T>(ctx.env, org, auth, verb, { repo, rev: at, ...body });
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const name = path.slice(path.lastIndexOf("/") + 1);
  const isDir = !path || (await read<{ entries: ArdiEntry[] }>("tree.list", { path: parent })).result.entries.some(e => e.name === name && e.kind === "tree");
  return isDir ? (await read<{ entries: ArdiEntry[] }>("tree.list", { path })).result
    : (await read<{ content_b64: string; size: number }>("file.show", { path })).result;
}

/**
 * Create the repository for a repo project, as the person or agent who made the project. The git host lets only admins
 * create repositories, so the hub spends a one-shot session (createRepoCreateSession) on this one call. A repository that
 * already exists is fine: it is the project's.
 */
export class RepoProvisioningPending extends HubError {
  constructor(reason: string) { super(503, "unavailable", `${reason} Repository outcome is unknown; project retained. Retry project.create with the same slug and kind.`); }
}

export async function createRepo(env: Env, db: D1Database, input: { identity_id: string; tenant_id: string; org: string; name: string }, now: number): Promise<void> {
  if (env.GIT_BACKEND === "artifacts") {
    const project = await db.prepare("/*perf-site:src%2Fcode%2Fardi.ts:89:27:createRepo:5d33999f*/ SELECT id FROM project WHERE tenant_id = ? AND slug = ? AND kind = 'repo'").bind(input.tenant_id, input.name).first<{ id: string }>();
    if (!project) throw new HubError(404, "not_found", "repository project not found");
    const api = new ArtifactsRest(env), namespace = artifactNamespace(input.org), ownership = repoOwnership(input.tenant_id, project.id);
    try {
      const info = await api.info(namespace, input.name);
      if (info.description !== ownership) throw new HubError(409, "conflict", "repository storage name is already owned");
    } catch (error) {
      if (!(error instanceof HubError) || error.status !== 404) throw error;
      try {
        await api.create(namespace, input.name, ownership);
      } catch (failure) {
        // A failed response can still mean storage committed the create. Never orphan its ownership marker.
        let info;
        try { info = await api.info(namespace, input.name); }
        catch (check) {
          if (check instanceof HubError && check.status === 404) throw failure;
          throw new RepoProvisioningPending(failure instanceof HubError ? failure.message : "Artifacts did not answer.");
        }
        if (info.description !== ownership) throw new HubError(409, "conflict", "repository storage name is already owned");
      }
    }
    try {
      await db.prepare("/*perf-site:src%2Fcode%2Fardi.ts:111:13:createRepo:7ea63596*/ INSERT OR IGNORE INTO git_repository (tenant_id, project_id, imported_at) VALUES (?, ?, ?)").bind(input.tenant_id, project.id, now).run();
    } catch { throw new RepoProvisioningPending("Repository created but its local mapping could not be saved."); }
    return;
  }
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
