// Push sync (2026-10-07): every few minutes the hub reads each repository's Ardi timeline from where it left off,
// mirrors the events (code_event), links commits that mention project#n to those work items, and posts a short
// notice of new pushes in #<project>-ops. Ardi doesn't notify the hub, so this is a cursor poll.
//
// It reads as "pimwell-sync", a reader agent per organization that answers to the organization's first admin. Its
// long-lived token is kept sealed; each run mints a fifteen-minute run session and revokes it at the end.
import type { Env } from "../env";
import { ulid } from "../ids";
import { open, seal } from "../models/secretbox";
import { createApiToken } from "../db/apiTokens";
import { createAgentSession, revokeSession } from "../db/sessions";
import { recordEvent } from "../db/events";
import { conversationStub } from "../chat/stubs";
import { ardiCall, type ArdiEvent } from "./ardi";
import { readGitSyncState, type GitSyncState } from "./syncState";

const PAGES_PER_REPO = 3;
const PAGE_SIZE = 100;

const SYNC_SLUG = "pimwell-sync";
const REF_IN_TEXT = /\b([a-z][a-z0-9-]{1,62})#(\d{1,8})\b/g;

type Tenant = { id: string; slug: string };
type Repo = { id: string; slug: string };

/** The organization's sync agent and its sealed token, created the first time. Null without an admin to answer to. */
export async function syncCredential(env: Env, t: Tenant, now: number): Promise<{ identity_id: string; token: string } | null> {
  const db = env.HUB_DB;
  const email = `${t.slug}.${SYNC_SLUG}@${env.HUB_DOMAIN}`;
  let agent = await db.prepare("SELECT id FROM identity WHERE email = ? AND kind = 'agent'").bind(email).first<{ id: string }>();
  if (!agent) {
    const op = await db.prepare(`SELECT i.id FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = ? AND m.state = 'active' AND m.role = 'admin'
      AND i.kind = 'human' AND i.state = 'active' ORDER BY m.created_at LIMIT 1`).bind(t.id).first<{ id: string }>();
    if (!op) return null;
    const id = ulid(now);
    await db.batch([
      db.prepare("INSERT INTO identity (id, kind, display_name, is_root, email, operator_id, state, created_at) VALUES (?, 'agent', 'Pimwell sync', 0, ?, ?, 'active', ?)").bind(id, email, op.id, now),
      db.prepare("INSERT INTO membership (id, identity_id, tenant_id, role, state, created_at) VALUES (?, ?, ?, 'reader', 'active', ?)").bind(ulid(now), id, t.id, now),
    ]);
    agent = { id };
  }
  const row = await db.prepare(`SELECT c.ciphertext, c.iv FROM ardi_cred c JOIN api_token a ON a.id = c.ref_id WHERE c.identity_id = ? AND c.tenant_id = ? AND c.kind = 'api_token' AND a.revoked_at IS NULL`)
    .bind(agent.id, t.id).first<{ ciphertext: string; iv: string }>();
  if (row) return { identity_id: agent.id, token: await open(env.HUB_SECRETS_KEY, row) };
  const op = await db.prepare("SELECT operator_id FROM identity WHERE id = ?").bind(agent.id).first<{ operator_id: string }>();
  const { token, plaintext } = await createApiToken(db, { identity_id: agent.id, tenant_id: t.id, name: "push sync", created_by: op!.operator_id, expires_at: null }, now);
  const sealed = await seal(env.HUB_SECRETS_KEY, plaintext);
  await db.prepare(`INSERT INTO ardi_cred (identity_id, tenant_id, kind, ref_id, ciphertext, iv, expires_at, created_at) VALUES (?, ?, 'api_token', ?, ?, ?, NULL, ?)
    ON CONFLICT (identity_id, tenant_id) DO UPDATE SET kind = excluded.kind, ref_id = excluded.ref_id, ciphertext = excluded.ciphertext, iv = excluded.iv, expires_at = NULL, created_at = excluded.created_at`)
    .bind(agent.id, t.id, token.id, sealed.ciphertext, sealed.iv, now).run();
  return { identity_id: agent.id, token: plaintext };
}

/** Sync every repository of every active organization. Errors are recorded per repository and never stop the rest. */
export async function syncAll(env: Env, now: number): Promise<{ repos: number; events: number }> {
  const tenants = (await env.HUB_DB.prepare("SELECT DISTINCT t.id, t.slug FROM tenant t JOIN project p ON p.tenant_id = t.id WHERE t.state = 'active' AND p.kind = 'repo' AND p.state = 'active'").all<Tenant>()).results;
  let repos = 0, events = 0;
  for (const t of tenants) {
    const cred = await syncCredential(env, t, now);
    if (!cred) continue;
    const tok = await env.HUB_DB.prepare("SELECT ref_id FROM ardi_cred WHERE identity_id = ? AND tenant_id = ?").bind(cred.identity_id, t.id).first<{ ref_id: string }>();
    const { session, token } = await createAgentSession(env.HUB_DB, { identity_id: cred.identity_id, tenant_id: t.id, label: "push sync", parent_token_id: tok!.ref_id, ttl_s: 900 }, now);
    try {
      const auth = `Basic ${btoa(`${SYNC_SLUG}:${token}`)}`;
      for (const r of (await env.HUB_DB.prepare("SELECT id, slug FROM project WHERE tenant_id = ? AND kind = 'repo' AND state = 'active'").bind(t.id).all<Repo>()).results) {
        repos++;
        events += await syncRepo(env, t, r, auth, now);
      }
    } finally {
      await revokeSession(env.HUB_DB, session.id, Date.now());
    }
  }
  return { repos, events };
}

async function syncRepo(env: Env, t: Tenant, r: Repo, auth: string, now: number): Promise<number> {
  const db = env.HUB_DB;
  const row = await db.prepare("SELECT cursor FROM code_sync WHERE tenant_id = ? AND project_id = ?").bind(t.id, r.id).first<{ cursor: string | null }>();
  // Legacy checkpoints started at Ardi's newest page. Replay quietly from zero to recover omitted history.
  const state: GitSyncState = readGitSyncState(row?.cursor ?? null) ?? {
    version: 1, after: 0, cutoff: null, phase: "backfill", head: 0, head_at: null,
    imported_at: null, observed_at: null, caught_up_at: null,
  };
  const save = (error: string | null) => db.prepare(`INSERT INTO code_sync (tenant_id, project_id, cursor, last_run_at, last_error) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (project_id) DO UPDATE SET cursor = excluded.cursor, last_run_at = excluded.last_run_at, last_error = excluded.last_error`)
    .bind(t.id, r.id, JSON.stringify(state), now, error).run();
  let total = 0;
  try {
    // Without since Ardi returns the newest page; since=0 walks all history forwards.
    const head = (await ardiCall<{ events: ArdiEvent[] }>(env, t.slug, auth, "timeline", { repo: r.slug, limit: 1 })).result.events.at(-1);
    state.head = head?.id ?? 0;
    state.head_at = head ? head.time * 1000 : null;
    state.observed_at = now;
    state.cutoff ??= state.head;
    await save(null);
    for (let pageNumber = 0; pageNumber < PAGES_PER_REPO; pageNumber++) {
      const page = await ardiCall<{ events: ArdiEvent[] }>(env, t.slug, auth, "timeline", { repo: r.slug, limit: PAGE_SIZE, since: String(state.after) });
      const got = page.result.events ?? [];
      if (got.length > PAGE_SIZE || got.some((e, i) => !Number.isSafeInteger(e.id) || e.id <= (i ? got[i - 1]!.id : state.after))) throw new Error("invalid git timeline page");
      await importPage(env, t, r, got, state.cutoff, now);
      const last = got.at(-1);
      if (last) {
        state.after = last.id;
        state.imported_at = last.time * 1000;
        if (last.id > state.head) { state.head = last.id; state.head_at = state.imported_at; }
      }
      total += got.length;
      // A null continuation proves exhaustion of this read, not continuous upstream freshness.
      if (page.next === null) {
        state.phase = "live";
        state.caught_up_at = now;
      }
      await save(null);
      if (page.next === null || !got.length) break;
    }
  } catch (e) {
    await save(e instanceof Error ? e.message.slice(0, 200) : "error");
  }
  return total;
}

async function importPage(env: Env, t: Tenant, r: Repo, got: ArdiEvent[], cutoff: number, now: number): Promise<void> {
  const db = env.HUB_DB;
  const ids = [...new Set(got.map((e) => e.principal).filter((x): x is string => !!x))];
  const known = new Set(ids.length ? (await db.prepare(`SELECT id FROM identity WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: string }>()).results.map((x) => x.id) : []);
  const stmts: D1PreparedStatement[] = got.map((e) => db.prepare(`INSERT OR IGNORE INTO code_event (tenant_id, project_id, ardi_id, kind, identity_id, session_id, ref, target, summary, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(t.id, r.id, e.id, String(e.kind).slice(0, 40), e.principal && known.has(e.principal) ? e.principal : null, e.session, e.ref, e.target, (e.summary ?? "").slice(0, 300), e.time * 1000));
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  const commits = got.filter((e) => e.id > cutoff && e.kind === "commit" && e.target);
  // Commits that mention project#n link to that work item, with an event on it.
  for (const c of commits) {
    for (const m of (c.summary ?? "").matchAll(REF_IN_TEXT)) {
      const w = await db.prepare("SELECT w.id, w.tenant_id FROM work_item w JOIN project p ON p.id = w.project_id WHERE p.tenant_id = ? AND p.slug = ? AND w.number = ?")
        .bind(t.id, m[1], Number(m[2])).first<{ id: string; tenant_id: string }>();
      if (!w) continue;
      const by = c.principal && known.has(c.principal) ? c.principal : null;
      const linked = await db.prepare("INSERT OR IGNORE INTO work_link (id, item_id, target_kind, target_ref, note, created_by, created_at) SELECT ?, ?, 'commit', ?, ?, COALESCE(?, (SELECT operator_id FROM identity WHERE email = ?)), ?")
        .bind(ulid(now), w.id, `${r.slug}@${c.target}`, (c.summary ?? "").slice(0, 200), by, `${t.slug}.${SYNC_SLUG}@${env.HUB_DOMAIN}`, now).run();
      // The pusher's session links the event only while the hub still has it (sessions are pruned; Ardi keeps ids).
      const sess = c.session && by ? await db.prepare("SELECT id FROM session WHERE id = ?").bind(c.session).first<{ id: string }>() : null;
      if (linked.meta.changes) await recordEvent(db, { tenant_id: t.id, identity_id: by, session_id: sess?.id ?? null, kind: "work.commit", target_kind: "work_item", target_id: w.id, summary: `Commit ${c.target!.slice(0, 8)} in ${r.slug}: ${(c.summary ?? "").slice(0, 150)}` }, now);
    }
  }
  // One notice per imported page with live commits.
  if (commits.length) {
    const ch = await db.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = ? AND kind = 'channel' AND state = 'active'").bind(t.id, `${r.slug}-ops`).first<{ id: string }>();
    if (ch) {
      const names = known.size ? new Map((await db.prepare(`SELECT id, display_name FROM identity WHERE id IN (${[...known].map(() => "?").join(",")})`).bind(...known).all<{ id: string; display_name: string }>()).results.map((x) => [x.id, x.display_name])) : new Map<string, string>();
      const who = [...new Set(commits.map((c) => (c.principal && names.get(c.principal)) || "someone"))].join(", ");
      const body = `${commits.length} new commit${commits.length === 1 ? "" : "s"} in ${r.slug} by ${who}: ${commits.slice(-3).map((c) => `${c.target!.slice(0, 8)} ${(c.summary ?? "").slice(0, 80)}`).join("; ")}`;
      try { await (conversationStub(env, t.id, ch.id) as unknown as { notice(a: string, b: string, c: string, d: number): Promise<unknown> }).notice(t.id, ch.id, body.slice(0, 500), now); } catch { /* the push is recorded either way */ }
    }
  }
}
