import { badRequest, conflict } from "../errors";
import { sha256Hex, ulid } from "../ids";
import type { ChannelRow } from "./chat";

export type PrivateChat = ChannelRow & { kind: "direct" | "group"; members: string[] };
const prefix = (tenant: string) => `private_chat:v1:${tenant}:`;

export async function privateChats(db: D1Database, tenant: string): Promise<PrivateChat[]> {
  const r = await db.prepare("/*perf-site:src%2Fdb%2FprivateChat.ts:9:19:r:4bfbf8e2*/ SELECT value FROM meta WHERE key GLOB ? ORDER BY key").bind(`${prefix(tenant)}*`).all<{ value: string }>();
  return r.results.map(r => JSON.parse(r.value) as PrivateChat);
}

export async function privateChat(db: D1Database, tenant: string, idOrSlug: string): Promise<PrivateChat | null> {
  const id = idOrSlug.replace(/^(dm|group)-/, "").toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
  const row = await db.prepare("/*perf-site:src%2Fdb%2FprivateChat.ts:16:21:row:8bdf4327*/ SELECT value FROM meta WHERE key = ?").bind(prefix(tenant) + id).first<{ value: string }>();
  if (!row) return null;
  const chat = JSON.parse(row.value) as PrivateChat;
  return idOrSlug === chat.slug || idOrSlug === chat.project_id ? chat : null;
}

/** One batch binds creation intent, descriptor and fixed membership. A losing retry rolls back and reconciles. */
export async function openPrivateChat(db: D1Database, tenant: string, caller: string, kind: "direct" | "group", members: string[], clientId: string, now: number): Promise<{ chat: PrivateChat; replayed: boolean }> {
  if (members.length < 2 || members.length > 20 || (kind === "direct" && members.length !== 2)) throw badRequest("direct chats need 2 participants; groups need 2–20");
  const intent = await sha256Hex(JSON.stringify({ kind, members }));
  const replayPrefix = `private_open:v1:${tenant}:${caller}:`;
  const key = replayPrefix + clientId;
  await db.prepare("/*perf-site:src%2Fdb%2FprivateChat.ts:28:9:openPrivateChat:a330b83a*/ DELETE FROM meta WHERE key GLOB ? AND json_extract(value, '$.created_at') <= ?").bind(`${replayPrefix}*`, now - 86_400_000).run();
  const prior = async () => {
    const row = await db.prepare("/*perf-site:src%2Fdb%2FprivateChat.ts:30:23:row:8bdf4327*/ SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
    if (!row) return null;
    const stored = JSON.parse(row.value) as { intent: string; id: string };
    if (stored.intent !== intent) throw conflict("client_id is bound to a different chat opening intent");
    const chat = await privateChat(db, tenant, stored.id);
    if (!chat || !chat.members.includes(caller)) throw conflict("chat opening no longer available");
    return { chat, replayed: true };
  };
  const previous = await prior();
  if (previous) return previous;
  // The pair is tenant-scoped and sorted: both participants and concurrent calls converge without a project row.
  const id = kind === "direct" ? (await sha256Hex(JSON.stringify([tenant, ...members]))).slice(0, 26).toUpperCase() : ulid(now);
  const chat: PrivateChat = { project_id: id, tenant_id: tenant, slug: `${kind === "direct" ? "dm" : "group"}-${id.toLowerCase()}`, kind, members,
    display_name: kind === "direct" ? "Direct chat" : "Group chat", state: "active", topic: "Private · fixed membership", agent_policy: "open", created_by: caller, created_at: now };
  try {
    await db.batch([
      db.prepare("/*perf-site:src%2Fdb%2FprivateChat.ts:46:7:openPrivateChat:081742f5*/ INSERT INTO meta (key, value) VALUES (?, ?)").bind(key, JSON.stringify({ intent, id, created_at: now })),
      db.prepare("/*perf-site:src%2Fdb%2FprivateChat.ts:47:7:openPrivateChat:6a5b395e*/ INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").bind(prefix(tenant) + id, JSON.stringify(chat)),
      ...members.map(member => db.prepare("/*perf-site:src%2Fdb%2FprivateChat.ts:48:32:openPrivateChat:3d8b2979*/ INSERT OR IGNORE INTO conversation_member (conversation_id, tenant_id, identity_id, role, added_by, added_at, removed_at) VALUES (?, ?, ?, 'participant', ?, ?, NULL)").bind(id, tenant, member, caller, now)),
    ]);
  } catch (e) {
    if (!String(e).includes("UNIQUE")) throw e;
    const reconciled = await prior();
    if (reconciled) return reconciled;
    throw e;
  }
  return { chat: (await privateChat(db, tenant, id))!, replayed: false };
}
