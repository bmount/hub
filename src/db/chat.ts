import { ulid } from "../ids";
import { badRequest, conflict } from "../errors";
import { isValidSlug } from "../tenant";
import type { State } from "./types";
import type { AgentPolicy } from "../chat/types";

/** A channel is a top-level project of kind `channel` plus its `channel` row (messaging spec 4.1). */
export type ChannelRow = {
  project_id: string; tenant_id: string; slug: string; display_name: string; state: State;
  topic: string; agent_policy: AgentPolicy; created_by: string; created_at: number;
};

export const TOPIC_MAX = 250;
/** A tenant-wide mute with no end (tripwire, or a mute without a duration). */
export const MUTE_FOREVER = 8_640_000_000_000_000;

const SELECT = `SELECT p.id AS project_id, p.tenant_id, p.slug, p.display_name, p.state, c.topic, c.agent_policy, c.created_by, c.created_at
  FROM channel c JOIN project p ON p.id = c.project_id`;

export async function createChannel(
  db: D1Database, input: { tenant_id: string; slug: string; display_name: string; topic: string; created_by: string }, now: number,
): Promise<ChannelRow> {
  const slug = input.slug.trim().toLowerCase();
  if (!isValidSlug(slug)) throw badRequest("invalid channel name");
  if (input.topic.length > TOPIC_MAX) throw badRequest("topic is too long");
  const display_name = input.display_name.trim() || slug;
  const clash = await db.prepare("SELECT 1 FROM namespace WHERE tenant_id = ? AND slug = ?").bind(input.tenant_id, slug).first();
  if (clash) throw conflict("name is used by a namespace");
  const id = ulid(now);
  try {
    await db.batch([
      db.prepare("INSERT INTO project (id, tenant_id, namespace_id, slug, kind, display_name, state, created_at) VALUES (?, ?, NULL, ?, 'channel', ?, 'active', ?)")
        .bind(id, input.tenant_id, slug, display_name, now),
      db.prepare("INSERT INTO channel (project_id, tenant_id, topic, agent_policy, created_by, created_at) VALUES (?, ?, ?, 'open', ?, ?)")
        .bind(id, input.tenant_id, input.topic, input.created_by, now),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("name is taken");
    throw e;
  }
  return { project_id: id, tenant_id: input.tenant_id, slug, display_name, state: "active", topic: input.topic, agent_policy: "open", created_by: input.created_by, created_at: now };
}

export function getChannelBySlug(db: D1Database, tenant_id: string, slug: string): Promise<ChannelRow | null> {
  return db.prepare(`${SELECT} WHERE p.tenant_id = ? AND p.namespace_id IS NULL AND p.slug = ?`).bind(tenant_id, slug.trim().toLowerCase()).first<ChannelRow>();
}

export function getChannelById(db: D1Database, tenant_id: string, id: string): Promise<ChannelRow | null> {
  return db.prepare(`${SELECT} WHERE p.tenant_id = ? AND p.id = ?`).bind(tenant_id, id).first<ChannelRow>();
}

export async function listChannels(db: D1Database, tenant_id: string, state: State): Promise<ChannelRow[]> {
  const r = await db.prepare(`${SELECT} WHERE p.tenant_id = ? AND p.state = ? ORDER BY p.slug`).bind(tenant_id, state).all<ChannelRow>();
  return r.results;
}

export async function setChannelTopic(db: D1Database, tenant_id: string, id: string, topic: string): Promise<void> {
  if (topic.length > TOPIC_MAX) throw badRequest("topic is too long");
  await db.prepare("UPDATE channel SET topic = ? WHERE project_id = ? AND tenant_id = ?").bind(topic, id, tenant_id).run();
}

export async function setAgentPolicy(db: D1Database, tenant_id: string, id: string, policy: AgentPolicy): Promise<void> {
  await db.prepare("UPDATE channel SET agent_policy = ? WHERE project_id = ? AND tenant_id = ?").bind(policy, id, tenant_id).run();
}

export async function setChannelState(db: D1Database, tenant_id: string, id: string, state: State): Promise<boolean> {
  const r = await db.prepare("UPDATE project SET state = ? WHERE id = ? AND tenant_id = ? AND kind = 'channel' AND state <> ?").bind(state, id, tenant_id, state).run();
  return r.meta.changes === 1;
}

/** True when the agent was not an active member before. */
export async function addAgentMember(
  db: D1Database, input: { conversation_id: string; tenant_id: string; identity_id: string; added_by: string }, now: number,
): Promise<boolean> {
  // Two concurrent adds both reach the INSERT; the loser's OR IGNORE changes nothing and it reports false.
  const ins = await db.prepare("INSERT OR IGNORE INTO conversation_member (conversation_id, tenant_id, identity_id, role, added_by, added_at, removed_at) VALUES (?, ?, ?, 'agent', ?, ?, NULL)")
    .bind(input.conversation_id, input.tenant_id, input.identity_id, input.added_by, now).run();
  if (ins.meta.changes === 1) return true;
  const back = await db.prepare(
    "UPDATE conversation_member SET added_by = ?, added_at = ?, removed_at = NULL WHERE conversation_id = ? AND tenant_id = ? AND identity_id = ? AND removed_at IS NOT NULL",
  ).bind(input.added_by, now, input.conversation_id, input.tenant_id, input.identity_id).run();
  return back.meta.changes === 1;
}

export async function removeAgentMember(db: D1Database, tenant_id: string, conversation_id: string, identity_id: string, now: number): Promise<boolean> {
  const r = await db.prepare("UPDATE conversation_member SET removed_at = ? WHERE tenant_id = ? AND conversation_id = ? AND identity_id = ? AND removed_at IS NULL")
    .bind(now, tenant_id, conversation_id, identity_id).run();
  return r.meta.changes === 1;
}

export async function listAgentMembers(db: D1Database, tenant_id: string, conversation_id: string): Promise<Array<{ identity_id: string; operator_id: string | null }>> {
  const r = await db.prepare(
    `SELECT cm.identity_id, i.operator_id FROM conversation_member cm JOIN identity i ON i.id = cm.identity_id
      WHERE cm.tenant_id = ? AND cm.conversation_id = ? AND cm.removed_at IS NULL AND i.state = 'active' ORDER BY cm.added_at, cm.identity_id`,
  ).bind(tenant_id, conversation_id).all<{ identity_id: string; operator_id: string | null }>();
  return r.results;
}

export async function isAgentMember(db: D1Database, tenant_id: string, conversation_id: string, identity_id: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 FROM conversation_member WHERE tenant_id = ? AND conversation_id = ? AND identity_id = ? AND removed_at IS NULL")
    .bind(tenant_id, conversation_id, identity_id).first();
  return r !== null;
}

export async function agentConversationIds(db: D1Database, tenant_id: string, identity_id: string): Promise<Set<string>> {
  const r = await db.prepare("SELECT conversation_id FROM conversation_member WHERE tenant_id = ? AND identity_id = ? AND removed_at IS NULL")
    .bind(tenant_id, identity_id).all<{ conversation_id: string }>();
  return new Set(r.results.map((x) => x.conversation_id));
}

/** Kill switch and muted agents, read on every agent post (spec 6.7). */
export async function getControls(db: D1Database, tenant_id: string, now: number): Promise<{ agents_enabled: boolean; muted: string[] }> {
  const [control, muted] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT agents_enabled FROM chat_control WHERE tenant_id = ?").bind(tenant_id),
    db.prepare("SELECT identity_id FROM agent_chat_state WHERE tenant_id = ? AND muted_until IS NOT NULL AND muted_until > ? ORDER BY identity_id").bind(tenant_id, now),
  ]);
  const row = control!.results[0] as { agents_enabled: number } | undefined;
  return { agents_enabled: row ? row.agents_enabled === 1 : true, muted: muted!.results.map((r) => (r as { identity_id: string }).identity_id) };
}

export async function setAgentsEnabled(db: D1Database, tenant_id: string, enabled: boolean, by: string, reason: string | null, now: number): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO chat_control (tenant_id, agents_enabled, changed_by, changed_at, reason) VALUES (?, ?, ?, ?, ?)")
    .bind(tenant_id, enabled ? 1 : 0, by, now, reason).run();
}

/**
 * `muted_until` null unmutes. Otherwise a mute never shortens an existing one (MAX), so an agent muting itself for a
 * minute cannot undo its operator's mute; `muted_by` and `reason` follow whichever mute is longer.
 * `muted_by` is null when the hub itself mutes (tripwire).
 */
export async function setAgentMute(db: D1Database, tenant_id: string, identity_id: string, muted_until: number | null, muted_by: string | null, reason: string | null): Promise<void> {
  await db.prepare(
    `INSERT INTO agent_chat_state (tenant_id, identity_id, muted_until, muted_by, reason) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (tenant_id, identity_id) DO UPDATE SET
       muted_until = CASE WHEN ?3 IS NULL THEN NULL ELSE MAX(COALESCE(muted_until, 0), ?3) END,
       muted_by = CASE WHEN ?3 IS NULL OR COALESCE(muted_until, 0) < ?3 THEN ?4 ELSE muted_by END,
       reason = CASE WHEN ?3 IS NULL OR COALESCE(muted_until, 0) < ?3 THEN ?5 ELSE reason END`,
  ).bind(tenant_id, identity_id, muted_until, muted_by, reason).run();
}

export async function agentMutedUntil(db: D1Database, tenant_id: string, identity_id: string, now: number): Promise<number | null> {
  const r = await db.prepare("SELECT muted_until FROM agent_chat_state WHERE tenant_id = ? AND identity_id = ? AND muted_until IS NOT NULL AND muted_until > ?")
    .bind(tenant_id, identity_id, now).first<{ muted_until: number }>();
  return r ? r.muted_until : null;
}
