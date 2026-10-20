import type { Ctx } from "../auth/context";
import type { Project } from "./types";
import { conflict, HubError } from "../errors";
import { conversationStub, inboxStub } from "../chat/stubs";
import { ArtifactsRest, artifactNamespace, isValidationCache } from "../code/artifactsRest";
import { repoOwnership } from "../code/artifactPush";
import { ulid } from "../ids";

// Used by the cascade and the schema-coverage test; children precede their parents.
export const PROJECT_DELETE_SCOPED_TABLES = ["repository_sync", "repository_commit", "repository", "contact_link", "contact_connection", "contact_entity", "document_delivery", "page_revision", "page_upload", "file_download", "file_revision", "file_upload", "file_multipart", "wiki_revision", "review", "app_error_group", "app_deploy", "site", "app_source", "code_event", "code_sync", "git_commit", "git_push", "git_legacy_forward", "git_repository", "model_call", "inbound_mail"] as const;
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

  const identityQuery = () => db.prepare("SELECT identity_id FROM membership WHERE tenant_id = ? UNION SELECT identity_id FROM conversation_member WHERE tenant_id = ?").bind(tid, tid);
  const [channelResult, initialIdentities] = await db.batch([
    db.prepare(`/*perf-site:src%2Fdb%2FprojectDelete.ts:24:27:deleteProject:663c5180*/ SELECT p.id FROM project p JOIN channel c ON c.project_id = p.id AND c.tenant_id = p.tenant_id
    WHERE p.tenant_id = ? AND p.namespace_id IS NULL AND p.kind = 'channel' AND (
      EXISTS (SELECT 1 FROM meta m WHERE m.key = 'project_channel:v1:' || p.tenant_id || ':' || p.id AND m.value = ?)
      OR (NOT EXISTS (SELECT 1 FROM meta m WHERE m.key = 'project_channel:v1:' || p.tenant_id || ':' || p.id) AND ? IS NULL AND p.created_at = ? AND c.created_at = ? AND (
        (p.slug = ? AND p.display_name = ?) OR (p.slug = ? AND p.display_name = ?))
        AND NOT EXISTS (SELECT 1 FROM event e WHERE e.tenant_id = p.tenant_id AND e.target_id = p.id AND e.kind = 'channel.create')))`)
    .bind(tid, project.id, project.namespace_id, project.created_at, project.created_at,
      `${project.slug}-team`, `${project.display_name} team`, `${project.slug}-ops`, `${project.display_name} ops`),
    identityQuery(),
  ]);
  const channels = (channelResult!.results as { id: string }[]).map(r => r.id);
  const startupIdentities = initialIdentities!.results as { identity_id: string }[];
  let nextStartup = 0;
  // First-touch allocation is read-only and can overlap D1 work. Destructive
  // RPCs still start only after the full rollback preflight has passed.
  const prepared = Promise.allSettled([
    ...channels.map(id => conversationStub(ctx.env, tid, id).preparePurge()),
    ...Array.from({ length: Math.min(10, startupIdentities.length) }, async () => {
      while (nextStartup < startupIdentities.length) {
        const { identity_id } = startupIdentities[nextStartup++]!;
        await inboxStub(ctx.env, tid, identity_id).preparePurge();
      }
    }),
  ]);
  let files: Promise<PromiseSettledResult<void>[]> | undefined;
  try {
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
      const marker = await db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:49:11:deleteProject:62b7165b*/ INSERT INTO meta (key, value) SELECT ?, 'deleting' FROM project WHERE id = ? AND tenant_id = ? AND state = 'archived' ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, project.id, tid).run();
      if (!marker.meta.changes) throw conflict("archive the project before deleting it");
    }
    const eventKind = throwaway ? "project.deleted" : "project.delete";
    const projects = "SELECT value FROM json_each(?2)";
    const items = `SELECT id FROM work_item WHERE tenant_id = ?1 AND project_id IN (${projects})`;
    const reviews = `SELECT id FROM review WHERE tenant_id = ?1 AND project_id IN (${projects})`;
    const mail = `SELECT id FROM inbound_mail WHERE tenant_id = ?1 AND project_id IN (${projects})`;
    const groups = `SELECT id FROM app_error_group WHERE tenant_id = ?1 AND project_id IN (${projects})`;
    const proposals = `SELECT id FROM work_proposal WHERE tenant_id = ?1 AND item_id IN (${items})`;
    const scoped = (sql: string) => db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:59:35:scoped:c34d43fb*/ " + (sql)).bind(tid, ids);
    const archiveStmts = [
      scoped(`UPDATE project SET state = 'archived' WHERE tenant_id = ?1 AND id IN (${projects})`),
      ...channels.map(id => db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:62:27:deleteProject:6a5b395e*/ INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").bind(`project_channel:v1:${tid}:${id}`, project.id)),
    ];

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
    const countResults = await db.batch<{ n: number }>([
      ...archiveStmts,
      ...rules.map(([table, condition]) => statement(`SELECT COUNT(*) AS n FROM ${table} WHERE ${condition}`, condition)),
    ]);
    rules.forEach(([table], i) => {
      const n = countResults[archiveStmts.length + i]!.results[0]?.n;
      if (n) counts[table] = n;
    });
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
    for (const prefix of ["mail_notice", "mail_conversation"]) {
      stmts.push(scoped(`DELETE FROM meta WHERE substr(key, 1, length('${prefix}:v1:' || ?1 || ':')) = '${prefix}:v1:' || ?1 || ':' AND json_valid(value) AND json_extract(value, '$.mail_id') IN (${mail})`));
    }
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

    const bucket = ctx.env.GIT_PUSH_STAGING;
    if (!bucket && (counts.file_revision || counts.page_revision)) throw new HubError(503, "unavailable", "file storage unavailable; sign in on the web and retry deletion");
    const purgeFiles = async () => {
      if (bucket) {
        // Only internal tenant/project ids select storage; trailing slash keeps sibling prefixes disjoint.
        const fileProjects = [project.id, ...channels];
        let nextProject = 0;
        const objects = await Promise.allSettled(Array.from({ length: Math.min(3, fileProjects.length) }, async () => {
          let total = 0;
          while (nextProject < fileProjects.length) {
            const id = fileProjects[nextProject++]!;
            let cursor: string | undefined;
            do {
              const page = await bucket.list({ prefix: `project-files/${tid}/${id}/`, cursor });
              if (page.objects.length) await bucket.delete(page.objects.map(o => o.key));
              total += page.objects.length;
              cursor = page.truncated ? page.cursor : undefined;
            } while (cursor);
          }
          return total;
        }));
        for (const result of objects) {
          if (result.status === "rejected") throw result.reason;
          counts.file_objects = (counts.file_objects ?? 0) + result.value;
        }
      }
    };
    // R2 cannot be recreated by a Conversation drain, so it need not wait for
    // cold object activation. Every started cleanup still settles on failure.
    files = Promise.allSettled([purgeFiles()]);

    // Owned channels are independent; settle both before purging inboxes so no
    // conversation drain can recreate an inbox entry after its purge.
    await prepared;
    const conversations = await Promise.allSettled(channels.map(id => conversationStub(ctx.env, tid, id).purge(tid, id)));
    for (const result of conversations) {
      if (result.status === "rejected") throw result.reason;
      counts.message_versions = (counts.message_versions ?? 0) + result.value;
    }
    const [mailResult, identityResult, mapping, repositoryResult] = await db.batch([
      scoped(`SELECT id FROM inbound_mail WHERE tenant_id = ?1 AND project_id IN (${projects})`),
      // Re-read after Conversation drains: a newly added recipient must not be missed.
      identityQuery(),
      db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:153:26:deleteProject:a8fde622*/ SELECT 1 FROM git_repository WHERE tenant_id = ? AND project_id = ?").bind(tid, project.id),
      db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:155:33:deleteProject:cf63d832*/ SELECT name, storage_name FROM repository WHERE tenant_id = ? AND project_id = ?").bind(tid, project.id),
    ]);
    const mailIds = (mailResult!.results as { id: string }[]).map(r => r.id);
    const identities = identityResult!.results as { identity_id: string }[];
    // Independent stores can be cleaned together, but both must drain on failure.
    const purgeInboxes = async () => {
      let nextIdentity = 0;
      const purges = await Promise.allSettled(Array.from({ length: Math.min(10, identities.length) }, async () => {
        let total = 0;
        while (nextIdentity < identities.length) {
          const { identity_id } = identities[nextIdentity++]!;
          total += await inboxStub(ctx.env, tid, identity_id).purgeProject(tid, identity_id, channels, mailIds);
        }
        return total;
      }));
      for (const result of purges) {
        if (result.status === "rejected") throw result.reason;
        if (result.value) counts.inbox_items = (counts.inbox_items ?? 0) + result.value;
      }

    };
    const stores = (await Promise.all([Promise.allSettled([purgeInboxes()]), files])).flat();
    for (const result of stores) if (result.status === "rejected") throw result.reason;
    { // Repository cleanup is independent of the creation template or enabled parts.
      const mapped = mapping!.results.length > 0;
      const repositories = repositoryResult!.results as { name: string; storage_name: string }[];
      if (project.kind === "repo" && !mapped && !repositories.length && ctx.env.ARDI_REPO_CREATE === "on") throw conflict("repository is not mapped to Artifacts; migrate it before deleting the project");
      if (mapped || repositories.length) {
        const api = new ArtifactsRest(ctx.env), ns = artifactNamespace(ctx.tenant!.slug);
        const pushes = (await db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:158:29:deleteProject:66af9d38*/ SELECT id, namespace, repo, shadow, replay_key FROM git_push WHERE tenant_id = ? AND project_id = ?").bind(tid, project.id)
          .all<{ id: string; namespace: string; repo: string; shadow: string; replay_key: string }>()).results;
        for (const push of pushes) {
          if (push.namespace !== ns) throw conflict("repository staging ownership mismatch");
          try { if (!isValidationCache(push.shadow)) await api.deleteTemporary(ns, push.shadow, push.id); }
          catch (e) { if (!(e instanceof HubError) || e.status !== 404) throw e; }
          if (push.replay_key) {
            if (!bucket) throw new HubError(503, "unavailable", "git staging storage unavailable");
            if (!push.replay_key.startsWith(`git-push/${tid}/${project.id}/`)) throw conflict("repository replay ownership mismatch");
            await bucket.delete(push.replay_key);
          }
        }
        if (!repositories.length) repositories.push({name: "default", storage_name: project.slug});
        for (const repo of repositories) await api.deleteProject(ns, repo.storage_name, repoOwnership(tid, project.id));
        counts.repositories = repositories.length;
      }
    }

    stmts.splice(1, 0, deletionEvent());
    stmts.push(db.prepare("/*perf-site:src%2Fdb%2FprojectDelete.ts:177:14:deleteProject:a535e921*/ DELETE FROM meta WHERE key = ?").bind(key));
    await db.batch(stmts);
    return { ok: true, slug: project.slug, counts };
  } finally {
    await files;
    await prepared;
  }
}
