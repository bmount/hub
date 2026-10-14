import type { Env } from "../env";

// Much longer than an upload request/capability lifetime. Object keys are unique
// per upload and never reused or attached by a later request.
export const FILE_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const FILE_CLEANUP_LIMIT = 100;
export const FILE_CLEANUP_CURSOR = "file_cleanup:v1:cursor";
const objectKey = /^project-files\/[0-9A-HJKMNP-TV-Z]{26}\/[0-9A-HJKMNP-TV-Z]{26}\/[0-9A-HJKMNP-TV-Z]{26}$/;

/** One bounded bucket page; scan storage, not live projects, to find deleted owners.
 * Dry runs neither delete objects nor advance the durable scan cursor.
 * All revisions (including hidden evidence) protect their exact key, even if a
 * historical row's owner disagrees with its prefix. D1 errors fail closed.
 */
export async function cleanupFileObjects(env: Env, now: number, dryRun = true) {
  const bucket = env.GIT_PUSH_STAGING;
  if (!bucket) return { scanned: 0, eligible: 0, deleted: 0, dry_run: dryRun, next_cursor: null };
  const cursor = (await env.HUB_DB.prepare("/*perf-site:src%2Fdb%2FfileCleanup.ts:18:25:cursor*/ SELECT value FROM meta WHERE key = ?").bind(FILE_CLEANUP_CURSOR).first<{value: string}>())?.value;
  const page = await bucket.list({ prefix: "project-files/", limit: FILE_CLEANUP_LIMIT, ...(cursor ? {cursor} : {}) });
  let eligible = 0, deleted = 0;
  for (const object of page.objects) {
    if (!objectKey.test(object.key) || !Number.isFinite(object.uploaded.getTime()) || object.uploaded.getTime() > now - FILE_ORPHAN_GRACE_MS) continue;
    // No current-version, deleted, tenant or project existence filter: every
    // surviving metadata reference is evidence that must remain readable.
    if (await env.HUB_DB.prepare("/*perf-site:src%2Fdb%2FfileCleanup.ts:25:15:cleanupFileObjects*/ SELECT 1 FROM file_revision WHERE object_key = ? LIMIT 1").bind(object.key).first()) continue;
    eligible++;
    if (!dryRun) {
      await bucket.delete(object.key);
      deleted++;
    }
  }
  const next = page.truncated ? page.cursor : null;
  if (!dryRun) await env.HUB_DB.prepare("/*perf-site:src%2Fdb%2FfileCleanup.ts:33:22:cleanupFileObjects*/ INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(FILE_CLEANUP_CURSOR, next ?? "").run();
  return { scanned: page.objects.length, eligible, deleted, dry_run: dryRun, next_cursor: next };
}
