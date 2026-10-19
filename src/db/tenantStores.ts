import type { Ctx } from "../auth/context";
import type { Tenant } from "./types";
import { conflict, HubError } from "../errors";
import { ArtifactsRest, artifactNamespace, isValidationCache } from "../code/artifactsRest";
import { repoOwnership } from "../code/artifactPush";
import { privateChats } from "./privateChat";
import { conversationStub, inboxStub } from "../chat/stubs";

/** Purge external stores before D1. Failures leave an archived organization retryable. */
export async function purgeTenantStores(ctx: Ctx, tenant: Tenant): Promise<void> {
  const db = ctx.db, tid = tenant.id, bucket = ctx.env.GIT_PUSH_STAGING;
  const repos = (await db.prepare("/*perf-site:src%2Fdb%2FtenantStores.ts:12:24:purgeTenantStores:9ed386eb*/ SELECT p.id, COALESCE(r.storage_name, p.slug) AS slug, COALESCE(r.project_id, g.project_id) AS mapped FROM project p LEFT JOIN git_repository g ON g.tenant_id = p.tenant_id AND g.project_id = p.id LEFT JOIN repository r ON r.project_id = p.id AND r.tenant_id = p.tenant_id WHERE p.tenant_id = ? AND (p.kind = 'repo' OR r.project_id IS NOT NULL)")
    .bind(tid).all<{ id: string; slug: string; mapped: string | null }>()).results;
  if (ctx.env.ARDI_REPO_CREATE === "on" && repos.some(r => !r.mapped)) throw conflict("repository is not mapped to Artifacts; migrate it before deleting the organization");
  const ns = artifactNamespace(tenant.slug);
  const api = () => new ArtifactsRest(ctx.env);
  const pushes = (await db.prepare("/*perf-site:src%2Fdb%2FtenantStores.ts:17:25:purgeTenantStores:1f806383*/ SELECT id, project_id, namespace, repo, shadow, replay_key FROM git_push WHERE tenant_id = ?")
    .bind(tid).all<{ id: string; project_id: string; namespace: string; repo: string; shadow: string; replay_key: string }>()).results;
  for (const push of pushes) {
    if (push.namespace !== ns || (push.replay_key && !push.replay_key.startsWith(`git-push/${tid}/${push.project_id}/`))) throw conflict("repository staging ownership mismatch");
    try { if (!isValidationCache(push.shadow)) await api().deleteTemporary(ns, push.shadow, push.id); }
    catch (e) { if (!(e instanceof HubError) || e.status !== 404) throw e; }
    if (push.replay_key) {
      if (!bucket) throw new HubError(503, "unavailable", "git staging storage unavailable");
      await bucket.delete(push.replay_key);
    }
  }
  for (const repo of repos) if (repo.mapped) await api().deleteProject(ns, repo.slug, repoOwnership(tid, repo.id));
  const channels = (await db.prepare("/*perf-site:src%2Fdb%2FtenantStores.ts:29:27:purgeTenantStores:04b6be51*/ SELECT project_id AS id FROM channel WHERE tenant_id = ?").bind(tid).all<{ id: string }>()).results.map(r => r.id);
  channels.push(...(await privateChats(db, tid)).map(c => c.project_id));
  for (const id of channels) await conversationStub(ctx.env, tid, id).purge(tid, id);
  const identities = (await db.prepare("/*perf-site:src%2Fdb%2FtenantStores.ts:32:29:purgeTenantStores:5600b7bc*/ SELECT identity_id FROM membership WHERE tenant_id = ? UNION SELECT identity_id FROM conversation_member WHERE tenant_id = ?")
    .bind(tid, tid).all<{ identity_id: string }>()).results;
  for (const { identity_id } of identities) await inboxStub(ctx.env, tid, identity_id).purgeTenant(tid, identity_id);
  if (!bucket && await db.prepare("/*perf-site:src%2Fdb%2FtenantStores.ts:35:24:purgeTenantStores:ce628869*/ SELECT 1 FROM file_revision WHERE tenant_id = ? LIMIT 1").bind(tid).first()) throw new HubError(503, "unavailable", "file storage unavailable");
  if (!bucket && await db.prepare("SELECT 1 FROM page_revision WHERE tenant_id = ? LIMIT 1").bind(tid).first()) throw new HubError(503, "unavailable", "page storage unavailable");
  if (bucket) for (const prefix of [`project-files/${tid}/`, `git-push/${tid}/`]) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, cursor });
      if (page.objects.length) await bucket.delete(page.objects.map(o => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}
