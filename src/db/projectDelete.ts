import type { Ctx } from "../auth/context";
import type { Project } from "./types";
import { conflict, HubError } from "../errors";
import { conversationStub, inboxStub } from "../chat/stubs";
import { ArtifactsRest, artifactNamespace } from "../code/artifactsRest";
import { repoOwnership } from "../code/artifactPush";
import { ulid } from "../ids";

// Used by the cascade and the schema-coverage test; children precede their parents.
export const PROJECT_DELETE_SCOPED_TABLES = ["repository_sync", "repository_commit", "repository", "contact_link", "contact_connection", "contact_entity", "document_delivery", "file_revision", "file_upload", "wiki_revision", "review", "app_error_group", "app_deploy", "site", "app_source", "code_event", "code_sync", "git_commit", "git_push", "git_legacy_forward", "git_repository", "model_call", "inbound_mail"] as const;
export const PROJECT_DELETE_OTHER_TABLES = ["channel", "work_item"] as const;

export const projectDeleteKey = (tenant: string, project: string) => `project_delete:v1:${tenant}:${project}`;

/** Preflight the D1 cascade with a rolled-back batch before touching external stores.
 * External stores are idempotently purged; the D1 cascade and its single event commit together.
 * A failed external purge leaves an archived, retryable project, never a successfully deleted shell.
 */
export async function deleteProject(ctx: Ctx, project: Project, throwaway = false) {
  const db = ctx.db, tid = ctx.tenant!.id;
  if (!throwaway && project.state !== "archived") throw conflict("archive the project before deleting it");
  const key = projectDeleteKey(tid, project.id);

  const channels = (await db.prepare(`/*perf-site:src%2Fdb%2FprojectDelete.ts:24:27:deleteProject:663c5180*/ SELECT p.id FROM project p JOIN channel c ON c.project_id = p.id AND c.tenant_id = p.tenant_id
    WHERE p.tenant_id = ? AND p.namespace_id IS NULL AND p.kind = 'channel' AND (
      EXISTS (SELECT 1 FROM meta m WHERE m.key = 'project_channel:v1:' || p.tenant_id || ':' || p.id AND m.value = ?)
      OR (NOT EXISTS (SELECT 1 FROM meta m WHERE m.key = 'project_channel:v1:' || p.tenant_id || ':' || p.id) AND ? IS NULL AND p.created_at = ? AND c.created_at = ? AND (
        (p.slug = ? AND p.display_name = ?) OR (p.slug = ? AND p.display_name = ?))
        AND NOT EXISTS (SELECT 1 FROM event e WHERE e.tenant_id = p.tenant_id AND e.target_id = p.id AND e.kind = 'channel.create')))`)
    .bind(tid, project.id, project.namespace_id, project.created_at, project.created_at,
      `${project.slug}-team`, `${project.display_name} team`, `${project.slug}-ops`, `${project.display_name} ops`)
    .all<{ id: string }>()).results.map(r => r.id);
  const ids = JSON.stringify([project.id, ...channels]);
  if (throwaway) {
    // Projects have no separate membership: explicit members live on their owned channels.
    // The original creation event is authoritative, not a later provisioning retry.
    const eligible = `substr(slug, 1, 4) = 'tmp-' AND kind NOT IN ('channel', 'agent-src')
      AND (SELECT identity_id FROM event WHERE tenant_id = ?3 AND target_id = ?2 AND target_kind = 'project' AND kind = 'project.create' ORDER BY created_at, id LIMIT 1) = ?4
      AND NOT EXISTS (SELECT 1 FROM conversation_member cm JOIN identity i ON i.id = cm.identity_id
        WHERE cm.tenant_id = ?3 AND cm.conversation_id IN (SELECT value FROM json_each(?5))
        AND cm.removed_at IS NULL AND cm.identity_id <> ?4 AND i.kind <> 'agent')`;
    // Reauthorize retries too; a deletion marker is not an authorization grant.
    const r = await db.prepare(`/*perf-site:src%2Fdb%2FprojectDelete.ts:43:21:deleteProject:270933fb*/ INSERT INTO meta (key, value)
      SELECT ?1, 'deleting' FROM project WHERE id = ?2 AND tenant_id = ?3 AND ${eligible}
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(key, project.id, tid, ctx.identity!.id, ids).run();
    if (!r.meta.changes) throw new HubError(403, "forbidden", "agents may only delete their own tmp- projects with no other human members; otherwise sign in on the web as an admin");
  } else {
    await db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:49:11:deleteProject:62b7165b*/ INSERT OR IGNORE INTO meta (key, value) SELECT ?, 'deleting' FROM project WHERE id = ? AND tenant_id = ? AND state = 'archived'").bind(key, project.id, tid).run();
    if (!await db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:50:16:deleteProject:44558753*/ SELECT 1 FROM meta WHERE key = ?").bind(key).first()) throw conflict("archive the project before deleting it");
  }
  const eventKind = throwaway ? "project.deleted" : "project.delete";
  const projects = "SELECT value FROM json_each(?2)";
  const items = `SELECT id FROM work_item WHERE tenant_id = ?1 AND project_id IN (${projects})`;
  const reviews = `SELECT id FROM review WHERE tenant_id = ?1 AND project_id IN (${projects})`;
  const mail = `SELECT id FROM inbound_mail WHERE tenant_id = ?1 AND project_id IN (${projects})`;
  const groups = `SELECT id FROM app_error_group WHERE tenant_id = ?1 AND project_id IN (${projects})`;
  const proposals = `SELECT id FROM work_proposal WHERE tenant_id = ?1 AND item_id IN (${items})`;
  const scoped = (sql: string) => db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:59:35:scoped:c34d43fb*/ " + (sql)).bind(tid, ids);
  await db.batch([
    scoped(`UPDATE project SET state = 'archived' WHERE tenant_id = ?1 AND id IN (${projects})`),
    ...channels.map(id => db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:62:27:deleteProject:6a5b395e*/ INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").bind(`project_channel:v1:${tid}:${id}`, project.id)),
  ]);

  const counts: Record<string, number> = {};
  const rules: Array<[string, string]> = [
    ["event", `tenant_id = ?1 AND ((target_kind IN ('project', 'channel') AND target_id IN (${projects})) OR (target_kind = 'work_item' AND target_id IN (${items})) OR (target_kind = 'inbound_mail' AND target_id IN (${mail})) OR (target_kind = 'review' AND target_id IN (${reviews})))`],
    ["work_proposal_decision", `proposal_id IN (${proposals})`],
    ["work_proposal", `tenant_id = ?1 AND item_id IN (${items})`],
    ["work_dep", `tenant_id = ?1 AND (prereq_id IN (${items}) OR dependent_id IN (${items}))`],
    ["work_resource", `tenant_id = ?1 AND item_id IN (${items})`],
    ["work_link", `item_id IN (${items})`],
    ["attention", `tenant_id = ?1 AND (item_id IN (${items}) OR EXISTS (SELECT 1 FROM review r JOIN project p ON p.id = r.project_id WHERE r.id IN (${reviews}) AND attention.href = '/' || p.slug || '/reviews/' || r.number AND attention.actor_id = r.author_id AND attention.created_at = r.created_at))`],
    ["follow", `tenant_id = ?1 AND ((target_kind = 'item' AND target_id IN (${items})) OR (target_kind = 'project' AND target_id IN (${projects})))`],
    ["work_comment", `tenant_id = ?1 AND item_id IN (${items})`],
    ["review_reviewer", `review_id IN (${reviews})`],
    ["review_comment", `tenant_id = ?1 AND review_id IN (${reviews})`],
    ["site_app", `site_id IN (SELECT id FROM site WHERE tenant_id = ?1 AND project_id IN (${projects})) OR app_id IN (SELECT id FROM app_source WHERE tenant_id = ?1 AND project_id IN (${projects}))`],
    ["app_event", `tenant_id = ?1 AND group_id IN (${groups})`],
    ["app_stat", `tenant_id = ?1 AND script_name IN (SELECT script_name FROM app_source WHERE tenant_id = ?1 AND project_id IN (${projects}))`],
    ["outbound_mail", `tenant_id = ?1 AND (in_reply_to IN (${mail}) OR from_address = ?3)`],
    ...PROJECT_DELETE_SCOPED_TABLES.map(table => [table, `tenant_id = ?1 AND project_id IN (${projects})`] as [string, string]),
    ...["msg_ref", "msg_index", "conversation_member"].map(table => [table, `tenant_id = ?1 AND conversation_id IN (${projects})`] as [string, string]),
    ...PROJECT_DELETE_OTHER_TABLES.map(table => [table, `tenant_id = ?1 AND project_id IN (${projects})`] as [string, string]),
    ["project", `tenant_id = ?1 AND id IN (${projects})`],
  ];
  const address = project.namespace_id === null ? `${ctx.tenant!.slug}.${project.slug}@${ctx.env.HUB_DOMAIN}` : "";
  const statement = (sql: string, condition: string) => db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:88:57:statement:c34d43fb*/ " + (sql)).bind(tid, ids, ...(condition.includes("?3") ? [address] : []));
  for (const [table, condition] of rules) {
    const n = (await statement(`SELECT COUNT(*) AS n FROM ${table} WHERE ${condition}`, condition).first<{ n: number }>())?.n;
    if (n) counts[table] = n;
  }
  const stmts = [db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:93:18:deleteProject:fba0ca60*/ PRAGMA defer_foreign_keys = true")];
  // Keep other projects' records, detaching only references that can no longer resolve.
  for (const [table, column] of [["work_item", "parent_id"], ["app_error_group", "work_item_id"], ["model_call", "work_item_id"]]) {
    stmts.push(scoped(`UPDATE ${table} SET ${column} = NULL WHERE tenant_id = ?1 AND ${column} IN (${items}) AND project_id NOT IN (${projects})`));
  }
  stmts.push(scoped(`DELETE FROM meta WHERE key IN (SELECT 'mail_actions:v1:' || ?1 || ':' || id FROM inbound_mail WHERE tenant_id = ?1 AND project_id IN (${projects}))`));
  stmts.push(scoped(`DELETE FROM meta WHERE key IN (SELECT 'mail_response_recipients:v1:' || ?1 || ':' || value FROM json_each(?2))`));
  stmts.push(scoped(`DELETE FROM meta WHERE key IN (SELECT 'project_channel:v1:' || ?1 || ':' || value FROM json_each(?2))`));
  stmts.push(scoped(`DELETE FROM meta WHERE key IN (SELECT 'repo-provision:' || ?1 || ':' || value FROM json_each(?2))`));
  stmts.push(scoped(`DELETE FROM meta WHERE substr(key, 1, length('review_request:v1:' || ?1 || ':')) = 'review_request:v1:' || ?1 || ':' AND json_valid(value) AND json_extract(value, '$.result.review.project_id') IN (${projects})`));
  stmts.push(scoped(`DELETE FROM meta WHERE substr(key, 1, length('mail_response_intent:v1:' || ?1 || ':')) = 'mail_response_intent:v1:' || ?1 || ':' AND substr(key, length('mail_response_intent:v1:' || ?1 || ':') + 1, 26) IN (${mail})`));
  stmts.push(scoped(`DELETE FROM meta WHERE (substr(key, 1, length('mail_replay:v1:' || ?1 || ':')) = 'mail_replay:v1:' || ?1 || ':' OR substr(key, 1, length('mail_welcome:v1:' || ?1 || ':')) = 'mail_welcome:v1:' || ?1 || ':') AND json_valid(value) AND json_extract(value, '$.mail_id') IN (${mail})`));
  for (const [table, condition] of rules) {
    // The one deletion event remains as the audit record.
    stmts.push(statement(`DELETE FROM ${table} WHERE ${condition}${table === "event" ? " AND kind NOT IN ('project.delete', 'project.deleted')" : ""}`, condition));
  }
  // Insert before removing the project; a simultaneous retry cannot create a second deletion event.
  const deletionEvent = () => db.prepare(`/*perf-site:src%2Fdb%2FprojectDelete.ts:110:31:deletionEvent:5f41a995*/ INSERT INTO event (id, tenant_id, identity_id, session_id, kind, target_kind, target_id, summary, created_at)
    SELECT ?, ?, ?, ?, ?, 'project', ?, ?, ? WHERE EXISTS (SELECT 1 FROM project WHERE tenant_id = ? AND id = ? AND state = 'archived')`)
    .bind(ulid(ctx.now), tid, ctx.identity!.id, ctx.session!.id, eventKind, project.id, `Deleted project ${project.slug}; counts ${JSON.stringify(counts)}`, ctx.now, tid, project.id);

  // D1 batches roll back on any statement failure. Check deferred FKs explicitly,
  // then deliberately collide with our existing deletion key to roll back the trial.
  // Only that terminal UNIQUE failure means the entire cascade passed.
  try {
    await db.batch([
      stmts[0]!, deletionEvent(), ...stmts.slice(1),
      db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:120:7:deleteProject:9d997d51*/ INSERT INTO meta (key, value) SELECT ?, NULL WHERE EXISTS (SELECT 1 FROM pragma_foreign_key_check)").bind(key),
      db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:121:7:deleteProject:081742f5*/ INSERT INTO meta (key, value) VALUES (?, 'preflight')").bind(key),
    ]);
    throw new Error("project deletion preflight did not roll back");
  } catch (e) {
    if (!String(e).includes("UNIQUE constraint failed: meta.key")) throw e;
  }

  for (const id of channels) counts.message_versions = (counts.message_versions ?? 0) + await conversationStub(ctx.env, tid, id).purge(tid, id);
  const mailIds = (await scoped(`SELECT id FROM inbound_mail WHERE tenant_id = ?1 AND project_id IN (${projects})`).all<{ id: string }>()).results.map(r => r.id);
  const identities = (await db.prepare(`/*perf-site:src%2Fdb%2FprojectDelete.ts:130:29:deleteProject:5600b7bc*/ SELECT identity_id FROM membership WHERE tenant_id = ? UNION SELECT identity_id FROM conversation_member WHERE tenant_id = ?`)
    .bind(tid, tid).all<{ identity_id: string }>()).results;
  for (const { identity_id } of identities) {
    const n = await inboxStub(ctx.env, tid, identity_id).purgeProject(tid, identity_id, channels, mailIds);
    if (n) counts.inbox_items = (counts.inbox_items ?? 0) + n;
  }

  const bucket = ctx.env.GIT_PUSH_STAGING;
  const files = await scoped(`SELECT COUNT(*) AS n FROM file_revision WHERE tenant_id = ?1 AND project_id IN (${projects})`).first<{ n: number }>();
  if (!bucket && files?.n) throw new HubError(503, "unavailable", "file storage unavailable; sign in on the web and retry deletion");
  if (bucket) {
    // Only internal tenant/project ids select storage; trailing slash keeps sibling prefixes disjoint.
    for (const id of [project.id, ...channels]) {
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix: `project-files/${tid}/${id}/`, cursor });
        if (page.objects.length) await bucket.delete(page.objects.map(o => o.key));
        counts.file_objects = (counts.file_objects ?? 0) + page.objects.length;
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
  }
  if (project.kind === "repo" || project.kind === "workspace") {
    const mapped = await db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:153:26:deleteProject:a8fde622*/ SELECT 1 FROM git_repository WHERE tenant_id = ? AND project_id = ?").bind(tid, project.id).first();
    if (project.kind === "repo" && !mapped && ctx.env.ARDI_REPO_CREATE === "on") throw conflict("repository is not mapped to Artifacts; migrate it before deleting the project");
    const repositories = (await db.prepare("SELECT name, storage_name FROM repository WHERE tenant_id = ? AND project_id = ?").bind(tid, project.id).all<{name: string; storage_name: string}>()).results;
    if (mapped || repositories.length) {
      const api = new ArtifactsRest(ctx.env), ns = artifactNamespace(ctx.tenant!.slug);
      const pushes = (await db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:157:29:deleteProject:7181cbc4*/ SELECT id, namespace, shadow, replay_key FROM git_push WHERE tenant_id = ? AND project_id = ?").bind(tid, project.id)
        .all<{ id: string; namespace: string; shadow: string; replay_key: string }>()).results;
      for (const push of pushes) {
        if (push.namespace !== ns) throw conflict("repository staging ownership mismatch");
        if (push.replay_key) {
          if (!bucket) throw new HubError(503, "unavailable", "git staging storage unavailable");
          if (!push.replay_key.startsWith(`git-push/${tid}/${project.id}/`)) throw conflict("repository replay ownership mismatch");
          try { await api.deleteTemporary(ns, push.shadow, push.id); }
          catch (e) { if (!(e instanceof HubError) || e.status !== 404) throw e; }
          await bucket.delete(push.replay_key);
        }
      }
      if (!repositories.length) repositories.push({name: "default", storage_name: project.slug});
      for (const repo of repositories) await api.deleteProject(ns, repo.storage_name, repoOwnership(tid, project.id));
      counts.repositories = repositories.length;
    }
  }

  stmts.splice(1, 0, deletionEvent());
  stmts.push(db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:175:14:deleteProject:a535e921*/ DELETE FROM meta WHERE key = ?").bind(key));
  await db.batch(stmts);
  return { ok: true, slug: project.slug, counts };
}
