import { readableChannels, type Viewer } from "./access";
import type { RefKind } from "./types";

export type Backlink = { channel: string; conversation_id: string; seq: number; msg_id: string; msg_kind: string; author_id: string; created_at: number };

/**
 * Messaging spec 5.3: where a target was referenced, by the latest version of each message (msg_ref holds only
 * those), filtered in SQL to channels the viewer can read, so unreadable channels cannot crowd out the page. The index lags commits by the inline flush, i.e. not at all
 * unless a flush failed and the alarm has not run yet.
 */
export async function backlinks(db: D1Database, v: Viewer, t: { kind: RefKind; key: string; prefix: boolean }, limit: number): Promise<Backlink[]> {
  const chans = [...(await readableChannels(db, v, "active")), ...(await readableChannels(db, v, "archived"))];
  const slug = new Map(chans.map((c) => [c.project_id, c.slug]));
  if (slug.size === 0) return [];
  // Keys are hub-built from [a-z0-9-], hex, '#', '@', '/', and ULIDs: no LIKE wildcards can appear in them.
  const r = await db.prepare(
    `SELECT r.conversation_id, r.msg_id, MAX(r.msg_kind) AS msg_kind, MAX(r.author_id) AS author_id, MAX(r.created_at) AS created_at,
            (SELECT MIN(i.seq) FROM msg_index i WHERE i.conversation_id = r.conversation_id AND i.msg_id = r.msg_id) AS seq
       FROM msg_ref r
      WHERE r.tenant_id = ? AND r.target_kind = ? AND ${t.prefix ? "r.target_key LIKE ?" : "r.target_key = ?"}
        AND r.conversation_id IN (SELECT value FROM json_each(?))
      GROUP BY r.conversation_id, r.msg_id ORDER BY created_at DESC LIMIT ?`,
  ).bind(v.tenant.id, t.kind, t.prefix ? `${t.key}%` : t.key, JSON.stringify([...slug.keys()]), limit)
    .all<{ conversation_id: string; msg_id: string; msg_kind: string; author_id: string; created_at: number; seq: number }>();
  return r.results.map((x) => ({ ...x, channel: slug.get(x.conversation_id)! }));
}
