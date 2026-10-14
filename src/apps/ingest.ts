// The hub's side of app telemetry (migration 0013). pimwell-tail calls this through the Ingest RPC entrypoint with
// already-redacted events. Only registered, approved apps count; everything else is dropped. Errors are grouped by
// cause, new script versions become deploys, AI usage lines join the usage ledger, and anything new is posted to the
// project's #<project>-ops channel by Pimwell itself.
import type { Env } from "../env";
import { ulid, sha256Hex } from "../ids";
import { usageStatement } from "../models/usage";
import { conversationStub } from "../chat/stubs";
import type { AppEvent } from "./redact";
import { validatedAppBatch } from "./validate";

const HOUR = 3_600_000;
const QUIET_MS = 24 * HOUR;          // an error group that comes back after a day is news again
const EXAMPLES_PER_GROUP = 50;

type Source = { script_name: string; tenant_id: string; project_id: string; slug: string; display_name: string };
type Problem = { kind: "exception" | "error" | "warn" | "status"; title: string; message: string; fingerprint?: string };

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** The same problem with different numbers, ids or quoted values groups together. */
export function normalize(s: string): string {
  return s.toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "#")
    .replace(/\b[0-9a-f]{12,}\b/g, "#").replace(/\d+/g, "#").replace(/"[^"]{0,200}"|'[^']{0,200}'/g, "\"…\"").replace(/\s+/g, " ").trim().slice(0, 300);
}

function problems(e: AppEvent): Problem[] {
  const out: Problem[] = [];
  for (const x of e.exceptions) out.push({ kind: "exception", title: `${x.name}: ${x.message}`.slice(0, 200), message: x.message, fingerprint: x.fingerprint });
  for (const l of e.logs) out.push({ kind: l.level === "error" ? "error" : "warn", title: l.text.slice(0, 200), message: l.text });
  if (!e.exceptions.length && e.status !== null && e.status >= 500) out.push({ kind: "status", title: `${e.method ?? ""} ${e.path ?? ""} answered ${e.status}`.trim(), message: `status ${e.status}` });
  return out;
}

export async function ingest(env: Env, raw: unknown, now: number): Promise<{ accepted: number; dropped: number }> {
  if (!Array.isArray(raw)) return { accepted: 0, dropped: 0 };
  const events = validatedAppBatch(raw, now);
  const db = env.HUB_DB;
  const scripts = [...new Set(events.map((e) => e.script))];
  if (!scripts.length) return { accepted: 0, dropped: raw.length };
  const marks = scripts.map(() => "?").join(",");
  const sources = new Map((await db.prepare(
    `/*perf-site:src%2Fapps%2Fingest.ts:47:34:sources:ccbc7d95*/ SELECT s.script_name, s.tenant_id, s.project_id, p.slug, p.display_name FROM app_source s JOIN project p ON p.id = s.project_id JOIN tenant t ON t.id = s.tenant_id
     WHERE s.script_name IN (${marks}) AND s.state = 'active' AND p.state = 'active' AND t.state = 'active'`,
  ).bind(...scripts).all<Source>()).results.map((s) => [s.script_name, s]));
  const mine = events.filter((e) => sources.has(e.script));
  if (!mine.length) return { accepted: 0, dropped: raw.length };

  // What is already known: deploys and error groups touched by this batch.
  const versions = [...new Set(mine.map((e) => e.version).filter((v): v is string => !!v))];
  // Cloudflare tail items carry the version UUID, but not consistently its tag. Resolve the commit from
  // authenticated release records, scoped to the exact source tenant/project (never another tenant's record).
  const deployRows = versions.length ? (await db.prepare(`/*perf-site:src%2Fapps%2Fingest.ts:58:47:deployRows:39dd54d6*/ SELECT tenant_id, project_id, script_name, version_id, tag FROM app_deploy
    WHERE version_id IN (${versions.map(() => "?").join(",")}) OR substr(version_id, 1, 36) IN (${versions.map(() => "?").join(",")})`)
    .bind(...versions, ...versions).all<{ tenant_id: string; project_id: string; script_name: string; version_id: string; tag: string | null }>()).results : [];
  const known = new Set<string>();
  const commits = new Map<string, string | null>();
  for (const d of deployRows) {
    const src = sources.get(d.script_name);
    if (!src || src.tenant_id !== d.tenant_id || src.project_id !== d.project_id) continue;
    known.add(`${d.script_name}:${d.version_id}`);
    if (!/^[0-9a-f-]{36}:[0-9a-f-]{36}$/i.test(d.version_id) || !/^[0-9a-f]{40}$/.test(d.tag ?? "")) continue;
    const k = `${d.script_name}:${d.version_id.slice(0, 36)}`;
    const prior = commits.get(k);
    commits.set(k, prior === undefined || prior === d.tag ? d.tag : null);
  }
  for (const e of mine) {
    const commit = commits.get(`${e.script}:${e.version}`);
    if (commit) e.tag = commit;
  }
  const found: Array<{ e: AppEvent; p: Problem; fp: string }> = [];
  for (const e of mine) for (const p of problems(e)) {
    const src = sources.get(e.script)!;
    found.push({ e, p, fp: p.fingerprint
      ? await sha256Hex(`${src.tenant_id}|${src.project_id}|${e.script}|${p.kind}|${p.fingerprint}`)
      : fnv(`${e.script}|${p.kind}|${normalize(p.title)}`) });
  }
  found.sort((a, b) => a.e.at - b.e.at);
  const fps = [...new Set(found.map((f) => f.fp))];
  const groups = new Map(fps.length ? (await db.prepare(`/*perf-site:src%2Fapps%2Fingest.ts:85:46:groups:0a026af3*/ SELECT id, fingerprint, last_seen FROM app_error_group WHERE fingerprint IN (${fps.map(() => "?").join(",")})`)
    .bind(...fps).all<{ id: string; fingerprint: string; last_seen: number }>()).results.map((g) => [g.fingerprint, g]) : []);

  const stmts: D1PreparedStatement[] = [];
  const notices: Array<{ src: Source; text: string }> = [];
  // Hourly counts and last seen.
  const counts = new Map<string, { src: Source; hour: number; requests: number; errors: number; exceptions: number }>();
  for (const e of mine) {
    const src = sources.get(e.script)!;
    const hour = Math.floor(e.at / HOUR) * HOUR;
    const k = `${e.script}:${hour}`;
    const c = counts.get(k) ?? { src, hour, requests: 0, errors: 0, exceptions: 0 };
    c.requests++;
    if (e.outcome !== "ok" || (e.status ?? 0) >= 500) c.errors++;
    c.exceptions += e.exceptions.length;
    counts.set(k, c);
  }
  for (const [k, c] of counts) {
    stmts.push(db.prepare(`/*perf-site:src%2Fapps%2Fingest.ts:103:16:ingest:046608ba*/ INSERT INTO app_stat (tenant_id, script_name, hour, requests, errors, exceptions) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (script_name, hour) DO UPDATE SET requests = requests + excluded.requests, errors = errors + excluded.errors, exceptions = exceptions + excluded.exceptions`)
      .bind(c.src.tenant_id, k.slice(0, k.lastIndexOf(":")), c.hour, c.requests, c.errors, c.exceptions));
  }
  for (const s of scripts) if (sources.has(s)) stmts.push(db.prepare("/*perf-site:src%2Fapps%2Fingest.ts:107:59:ingest:ae2ead44*/ UPDATE app_source SET last_event_at = ? WHERE script_name = ?").bind(now, s));
  // Deploys: each version seen for the first time.
  const seenVersions = new Set<string>();
  for (const e of mine) {
    if (!e.version) continue;
    const k = `${e.script}:${e.version}`;
    if (seenVersions.has(k)) continue;
    seenVersions.add(k);
    const src = sources.get(e.script)!;
    if (known.has(k)) {
      if (e.tag) stmts.push(db.prepare("/*perf-site:src%2Fapps%2Fingest.ts:117:29:ingest:53947e97*/ UPDATE app_deploy SET tag = ? WHERE script_name = ? AND version_id = ? AND tenant_id = ? AND project_id = ? AND tag IS NULL")
        .bind(e.tag, e.script, e.version, src.tenant_id, src.project_id));
      continue;
    }
    stmts.push(db.prepare("/*perf-site:src%2Fapps%2Fingest.ts:121:16:ingest:fe51b459*/ INSERT OR IGNORE INTO app_deploy (id, tenant_id, project_id, script_name, version_id, tag, message, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(ulid(now), src.tenant_id, src.project_id, e.script, e.version, e.tag, e.message, e.at));
    notices.push({ src, text: `Deployed ${e.script}${e.tag ? ` ${e.tag}` : ""}${e.message ? `: ${e.message}` : ""} (version ${e.version.slice(0, 8)}).` });
  }
  // Error groups.
  const perGroup = new Map<string, number>();
  for (const f of found) {
    const src = sources.get(f.e.script)!;
    let g = groups.get(f.fp);
    if (!g) {
      g = { id: ulid(now), fingerprint: f.fp, last_seen: f.e.at };
      groups.set(f.fp, g);
      stmts.push(db.prepare(`/*perf-site:src%2Fapps%2Fingest.ts:133:18:ingest:7a95f4f9*/ INSERT INTO app_error_group (id, tenant_id, project_id, script_name, fingerprint, kind, title, last_message, count, first_seen, last_seen, first_version, last_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).bind(g.id, src.tenant_id, src.project_id, f.e.script, f.fp, f.p.kind, f.p.title, f.p.message, f.e.at, f.e.at, f.e.version, f.e.version));
      notices.push({ src, text: `New ${f.p.kind === "status" ? "server error" : f.p.kind} in ${f.e.script}: ${f.p.title}` });
    } else {
      if (now - g.last_seen > QUIET_MS) notices.push({ src, text: `Back again after a quiet day in ${f.e.script}: ${f.p.title}` });
      g.last_seen = f.e.at;
      stmts.push(db.prepare("/*perf-site:src%2Fapps%2Fingest.ts:139:18:ingest:092591c0*/ UPDATE app_error_group SET count = count + 1, first_version = CASE WHEN ? < first_seen THEN ? ELSE first_version END, first_seen = MIN(first_seen, ?), last_message = CASE WHEN ? >= last_seen THEN ? ELSE last_message END, last_version = CASE WHEN ? >= last_seen THEN COALESCE(?, last_version) ELSE last_version END, last_seen = MAX(last_seen, ?) WHERE id = ?")
        .bind(f.e.at, f.e.version, f.e.at, f.e.at, f.p.message, f.e.at, f.e.version, f.e.at, g.id));
    }
    const n = (perGroup.get(g.id) ?? 0) + 1;
    perGroup.set(g.id, n);
    if (n <= 3) {
      stmts.push(db.prepare("/*perf-site:src%2Fapps%2Fingest.ts:145:18:ingest:1bd8ab52*/ INSERT INTO app_event (id, tenant_id, group_id, version_id, at, method, path, status, ray, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(ulid(now), src.tenant_id, g.id, f.e.version, f.e.at, f.e.method, f.e.path, f.e.status, f.e.ray, f.p.message));
    }
  }
  for (const id of perGroup.keys()) {
    stmts.push(db.prepare(`/*perf-site:src%2Fapps%2Fingest.ts:150:16:ingest:f21bc7a9*/ DELETE FROM app_event WHERE group_id = ? AND id NOT IN (SELECT id FROM app_event WHERE group_id = ? ORDER BY at DESC LIMIT ${EXAMPLES_PER_GROUP})`).bind(id, id));
  }
  // AI usage the app logged.
  for (const e of mine) {
    const src = sources.get(e.script)!;
    for (const u of e.usage) {
      stmts.push(usageStatement(db, {
        id: ulid(now), source: "app", purpose: u.purpose ?? "app", provider: u.provider, model: u.model, tenant_id: src.tenant_id, identity_id: null, project_id: src.project_id,
        client: e.script, ok: true, ms: 0, input_tokens: u.input_tokens, output_tokens: u.output_tokens, cached_tokens: u.cached_tokens,
        reported_cost_micros: u.cost_usd === null ? null : Math.round(u.cost_usd * 1_000_000), created_at: e.at,
      }));
    }
  }
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  await postNotices(env, notices.slice(0, 10), now);
  return { accepted: mine.length, dropped: raw.length - mine.length };
}

/** Pimwell's own message in #<project>-ops; a project without that channel just doesn't get one. */
async function postNotices(env: Env, notices: Array<{ src: Source; text: string }>, now: number): Promise<void> {
  for (const n of notices) {
    const ch = await env.HUB_DB.prepare("/*perf-site:src%2Fapps%2Fingest.ts:171:22:ch:7caf507d*/ SELECT id FROM project WHERE tenant_id = ? AND slug = ? AND kind = 'channel' AND state = 'active'").bind(n.src.tenant_id, `${n.src.slug}-ops`).first<{ id: string }>();
    if (!ch) continue;
    try {
      await (conversationStub(env, n.src.tenant_id, ch.id) as unknown as { notice(t: string, c: string, body: string, now: number): Promise<unknown> }).notice(n.src.tenant_id, ch.id, n.text.slice(0, 500), now);
    } catch (e) {
      console.error(JSON.stringify({ msg: "ops notice failed", error: e instanceof Error ? e.name : "error" }));
    }
  }
}
