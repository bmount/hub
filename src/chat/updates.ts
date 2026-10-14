import { getChannelById, type ChannelRow } from "../db/chat";

export type ChatUpdate = { update_id: number; type: string; chat: { id: string; kind: "channel" | "thread" | "direct" | "group"; root?: string }; data: Record<string, unknown> };
export type UpdateDelivery = Omit<ChatUpdate, "update_id"> & { key: string; created_at: number };

/** Current channel audience; agents never inherit human-wide channel visibility. */
export async function updateAudience(db: D1Database, tenant: string, conversation: string, channel?: ChannelRow | null): Promise<string[]> {
  const chat = channel === undefined ? await getChannelById(db, tenant, conversation) : channel;
  if (!chat) return [];
  const rows = await db.prepare(`/*perf-site:src%2Fchat%2Fupdates.ts:10:22:updateAudience:d82dafcb*/ SELECT i.id FROM identity i JOIN membership m ON m.identity_id = i.id
    WHERE m.tenant_id = ?1 AND m.state = 'active' AND m.role IN ('reader','member','admin') AND i.state = 'active'
    AND ((?3 = 0 AND i.kind = 'human') OR EXISTS (SELECT 1 FROM conversation_member cm WHERE cm.tenant_id = ?1
      AND cm.conversation_id = ?2 AND cm.identity_id = i.id AND cm.removed_at IS NULL))`).bind(tenant, conversation, chat.members ? 1 : 0).all<{ id: string }>();
  return rows.results.map(r => r.id).filter(id => !chat.members || chat.members.includes(id));
}

