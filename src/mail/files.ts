import type { Attachment } from "postal-mime";
import type { Env } from "../env";
import { roleFor, rank, type Ctx } from "../auth/context";
import { getMembership } from "../db/memberships";
import { getIdentityById } from "../db/identities";
import { getTenantById } from "../db/tenants";
import { filePath, fileType, putFile } from "../verbs/files";
import { HubError } from "../errors";
import { ulid } from "../ids";
import { retainAttachmentEvidence } from "./attachments";

/** Only durable admitted project mail may create project files. Quarantine and agent mail never do.
 * Source IDs make retries idempotent, including a replay after a lost response.
 */
export async function retainProjectMailFiles(env: Env, mailId: string, parts: Attachment[], now: number): Promise<void> {
  const m = await env.HUB_DB.prepare(`/*perf-site:src%2Fmail%2Ffiles.ts:16:19:retainProjectMailFiles:94267479*/ SELECT m.tenant_id, m.project_id, m.identity_id, p.slug FROM inbound_mail m JOIN project p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
    WHERE m.id = ? AND m.verdict = 'admitted' AND m.reason IS NULL AND m.released_by IS NULL AND EXISTS (SELECT 1 FROM json_each(p.parts) WHERE value = 'wiki') AND p.state = 'active' AND m.recipient_id IS NULL`).bind(mailId).first<{tenant_id: string; project_id: string; identity_id: string; slug: string}>();
  if (!m) return;
  const tenant = await getTenantById(env.HUB_DB, m.tenant_id), identity = await getIdentityById(env.HUB_DB, m.identity_id);
  if (!tenant || tenant.state !== "active" || !identity || identity.kind !== "human") return;
  const role = roleFor(identity, await getMembership(env.HUB_DB, identity.id, tenant.id));
  if (rank(role) < rank("member")) return;
  const ctx = {env, db: env.HUB_DB, now, tenant, identity, role, session: null, mcpProject: {id: m.project_id, slug: m.slug, path: m.slug}} as Ctx;
  const evidence = retainAttachmentEvidence(parts);
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i]!, e = evidence[i]!;
    try {
      // Sender-controlled paths cannot select folders or overwrite arbitrary project documents.
      const name = (a.filename ?? `attachment-${i + 1}`).replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 180);
      const path = filePath(`mail/${name}`);
      const type = fileType(path, a.mimeType);
      const bytes = typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content);
      const source = `mail:${mailId}:${i}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        const revision = await env.HUB_DB.prepare("/*perf-site:src%2Fmail%2Ffiles.ts:35:32:retainProjectMailFiles:1ea511b3*/ SELECT COALESCE(MAX(revision), 0) AS n FROM file_revision WHERE tenant_id = ? AND project_id = ? AND path = ?").bind(m.tenant_id, m.project_id, path).first<number>("n");
        try {
          const result = await putFile(ctx, {project: m.slug, path, content_type: type, expected_revision: revision ?? 0, item_id: null, person_id: null}, bytes, source);
          e.file_path = result.path; e.file_revision = result.revision; e.file_status = "stored";
          break;
        } catch (err) {
          // Concurrent copies may have committed the same source or another version.
          if (err instanceof HubError && err.reason === "conflict" && attempt < 2) continue;
          throw err;
        }
      }
    } catch (err) {
      if (!(err instanceof HubError)) throw err; // storage outages remain retryable, not false success
      e.file_status = "not_stored"; e.file_reason = err.detail ?? err.reason;
    }
  }
  for (let i = 0; i < evidence.length; i++) {
    const e = evidence[i]!;
    const summary = `Attachment ${i + 1}: ${e.file_status === "stored" ? `filed ${e.file_path} revision ${e.file_revision}` : `not filed: ${e.file_reason ?? "unsupported attachment"}`}`.slice(0,300);
    await env.HUB_DB.prepare(`/*perf-site:src%2Fmail%2Ffiles.ts:54:11:retainProjectMailFiles:04a67dd3*/ INSERT INTO event (id, tenant_id, identity_id, session_id, kind, target_kind, target_id, summary, created_at)
      SELECT ?, ?, ?, NULL, 'mail.attachment', 'inbound_mail', ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM event WHERE tenant_id = ? AND kind = 'mail.attachment' AND target_id = ? AND summary = ?)`)
      .bind(ulid(now), m.tenant_id, m.identity_id, mailId, summary, now, m.tenant_id, mailId, summary).run();
  }
  await env.HUB_DB.prepare("/*perf-site:src%2Fmail%2Ffiles.ts:59:9:retainProjectMailFiles:4f248abe*/ UPDATE inbound_mail SET attachments = ? WHERE id = ? AND tenant_id = ? AND project_id = ? AND verdict = 'admitted'").bind(JSON.stringify(evidence), mailId, m.tenant_id, m.project_id).run();
}
