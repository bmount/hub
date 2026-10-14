import type { Env } from "../env";
import { buildContext } from "../auth/context";
import { sameOrigin } from "./login";
import { readRequestBytes } from "./body";
import { takeRateDetail } from "../rate";
import { sha256Hex, ulid } from "../ids";

// Fixed labels only: neither URLs, query keys, project names nor user content are accepted.
export const CLIENT_PATHS = ["/", "/docket", "/people", "/apps", "/jump", "/search", "/assistant", "/do", "/new", "/attention", "/c/:channel", "/:project", "/:project/docket", "/:project/w/:number", "/api/:verb", "/voice/:operation", "/other"];
export const CLIENT_PHASES = ["navigation", "headers", "body", "render", "spinner"];
export const CLIENT_RESULTS = ["slow", "failure", "timeout"];

export async function clientSlow(request: Request, env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  const reply = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });
  if (!sameOrigin(request) || request.headers.get("x-pimwell-client") !== "1") return reply(403);
  const ctx = await buildContext(request, env, Date.now(), waitUntil);
  if (!ctx.identity || !ctx.tenant || !ctx.role || ctx.authKind !== "cookie" || ctx.session?.kind !== "browser") return reply(403);
  if (!(await takeRateDetail(env.RATE, "client_slow_identity", ctx.identity.id, ctx.now, waitUntil)).ok) return reply(429);
  let x: Record<string, unknown>;
  try { x = JSON.parse(new TextDecoder().decode(await readRequestBytes(request, 1024, 3000))); } catch { return reply(400); }
  if (!x || typeof x !== "object" || Array.isArray(x) || Object.keys(x).some(k => !["path", "duration", "phase", "result", "status"].includes(k)) ||
      !CLIENT_PATHS.includes(x.path as string) || !CLIENT_PHASES.includes(x.phase as string) || !CLIENT_RESULTS.includes(x.result as string) ||
      !Number.isSafeInteger(x.duration) || (x.duration as number) < 0 || (x.duration as number) > 3_600_000 ||
      !(x.status === null || (Number.isInteger(x.status) && (x.status as number) >= 100 && (x.status as number) <= 599))) return reply(400);
  // Use only this tenant's approved source; never let a client choose a source or another tenant's group.
  const source = await ctx.db.prepare("/*perf-site:src%2Fhttp%2FclientSlow.ts:26:24:clientSlow:d7c3b932*/ SELECT s.project_id FROM app_source s JOIN project p ON p.id = s.project_id AND p.tenant_id = s.tenant_id WHERE s.tenant_id = ? AND s.script_name = 'pimwell-hub' AND s.state = 'active' AND p.state = 'active'").bind(ctx.tenant.id).first<{ project_id: string }>();
  if (!source) return reply(204);
  const fingerprint = await sha256Hex(`${ctx.tenant.id}|client|${x.path}|${x.phase}|${x.result}`);
  const title = `Browser ${x.result}: ${x.path} (${x.phase})`;
  const detail = `duration=${x.duration}ms phase=${x.phase} status=${x.status ?? "none"}`;
  const id = ulid(ctx.now);
  await ctx.db.batch([
    ctx.db.prepare(`/*perf-site:src%2Fhttp%2FclientSlow.ts:33:5:clientSlow:bdffbcf9*/ INSERT INTO app_error_group (id, tenant_id, project_id, script_name, fingerprint, kind, client_kind, title, last_message, count, first_seen, last_seen)
      VALUES (?, ?, ?, 'pimwell-hub', ?, 'warn', 'slow', ?, ?, 1, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET count = count + 1, last_message = excluded.last_message, last_seen = excluded.last_seen`)
      .bind(id, ctx.tenant.id, source.project_id, fingerprint, title, detail, ctx.now, ctx.now),
    ctx.db.prepare(`/*perf-site:src%2Fhttp%2FclientSlow.ts:37:5:clientSlow:34d0c4f9*/ INSERT INTO app_event (id, tenant_id, group_id, at, path, status, detail)
      SELECT ?, ?, id, ?, ?, ?, ? FROM app_error_group WHERE fingerprint = ? AND tenant_id = ?`)
      .bind(ulid(ctx.now), ctx.tenant.id, ctx.now, x.path, x.status, detail, fingerprint, ctx.tenant.id),
    ctx.db.prepare(`/*perf-site:src%2Fhttp%2FclientSlow.ts:40:5:clientSlow:c072b339*/ DELETE FROM app_event WHERE group_id = (SELECT id FROM app_error_group WHERE fingerprint = ? AND tenant_id = ?)
      AND id NOT IN (SELECT id FROM app_event WHERE group_id = (SELECT id FROM app_error_group WHERE fingerprint = ? AND tenant_id = ?) ORDER BY at DESC, id DESC LIMIT 50)`)
      .bind(fingerprint, ctx.tenant.id, fingerprint, ctx.tenant.id),
  ]);
  return reply(204);
}
