import { rank, type Ctx } from "../auth/context";
import { HubError } from "../errors";
import { sha256Hex, ulid } from "../ids";

export const DAILY_DOWNLOAD_BYTES = 50 * 1024 ** 3;
export const adminSituations = (ctx: Ctx, alias = "s") => `(${alias}.admin_only = 0 OR ${rank(ctx.role) >= rank("admin") ? 1 : 0} = 1)`;

/** Reserve before handing bytes to the caller. Aborted streams conservatively consume their reservation. */
export async function recordFileDownload(ctx: Ctx, projectId: string, file: {path: string; revision: number}, bytes: number, operation: "download" | "file_get") {
  const tid = ctx.tenant!.id, who = ctx.identity!.id, day = Math.floor(ctx.now / 86_400_000);
  // Ops-only override, scoped to a project so a live exercise cannot lower other projects' budget.
  const override = await ctx.db.prepare("SELECT value FROM meta WHERE key = ?").bind(`file_download_budget:${tid}:${projectId}`).first<string>("value");
  const limit = override !== null && /^\d+$/.test(override) && Number.isSafeInteger(Number(override)) ? Math.min(DAILY_DOWNLOAD_BYTES, Number(override)) : DAILY_DOWNLOAD_BYTES;
  const id = ulid(ctx.now);
  const result = await ctx.db.batch([
    ctx.db.prepare("INSERT OR IGNORE INTO file_download_day (tenant_id, identity_id, day, bytes) VALUES (?, ?, ?, 0)").bind(tid, who, day),
    ctx.db.prepare("UPDATE file_download_day SET bytes = bytes + ? WHERE tenant_id = ? AND identity_id = ? AND day = ? AND bytes + ? <= ?").bind(bytes, tid, who, day, bytes, limit),
    ctx.db.prepare("INSERT INTO file_download (id, tenant_id, project_id, identity_id, path, revision, bytes, source, operation, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1")
      .bind(id, tid, projectId, who, file.path, file.revision, bytes, ctx.identity!.kind === "agent" ? "agent" : "web", operation, ctx.now),
  ]);
  if (result[2]!.meta.changes) return;
  // Stable per identity/UTC-day IDs deduplicate concurrent refusals and survive request retries.
  const situation = (await sha256Hex(`file-budget:${tid}:${who}:${day}`)).slice(0, 26).toUpperCase();
  const title = "Daily file download budget exceeded";
  const report = `Identity ${who} was refused ${bytes} bytes from ${file.path} revision ${file.revision}. Project ${projectId}. UTC day ${new Date(day * 86_400_000).toISOString().slice(0,10)}; limit ${limit} bytes. Organization admins should investigate a possibly stolen or misused credential. No refused bytes were sent.`;
  await ctx.db.batch([
    ctx.db.prepare("INSERT OR IGNORE INTO assistant_thread (id, tenant_id, identity_id, title, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, 'read', ?, ?)").bind(situation, tid, "file-download-monitor", title, ctx.now, ctx.now),
    ctx.db.prepare("INSERT OR IGNORE INTO situation (id, tenant_id, identity_id, thread_id, title, question, report, created_at, admin_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)").bind(situation, tid, who, situation, title, title, report, ctx.now),
  ]);
  throw new HubError(429, "download_budget", "Daily file download budget exceeded; organization admins have a Situation to investigate.");
}

export async function fileDownloadAudit(ctx: Ctx, projectId: string, path: string) {
  if (rank(ctx.role) < rank("admin")) return undefined;
  return (await ctx.db.prepare(`SELECT d.path, d.revision, d.bytes, d.source, d.operation, d.created_at, d.identity_id, i.display_name AS who
    FROM file_download d JOIN identity i ON i.id = d.identity_id
    WHERE d.tenant_id = ? AND d.project_id = ? AND d.path = ? ORDER BY d.created_at DESC, d.id DESC LIMIT 100`).bind(ctx.tenant!.id, projectId, path).all()).results;
}
