import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MUTE_FOREVER, addAgentMember, agentConversationIds, agentMutedUntil, createChannel, getChannelById, getChannelBySlug, getControls,
  isAgentMember, listAgentMembers, listChannels, removeAgentMember, setAgentMute, setAgentPolicy, setAgentsEnabled, setChannelState, setChannelTopic,
} from "../src/db/chat";
import { seedAgent, seedHuman, seedTenant } from "./helpers";

async function world() {
  const acme = await seedTenant("acme");
  const lead = await seedHuman("lead@example.com", { memberships: [{ tenant_id: acme.id, role: "admin" }] });
  return { acme, lead };
}

describe("chat repository", () => {
  it("creates a channel as a top-level project of kind channel", async () => {
    const { acme, lead } = await world();
    const ch = await createChannel(env.HUB_DB, { tenant_id: acme.id, slug: "General", display_name: "General", topic: "", created_by: lead.identity.id }, Date.now());
    expect(ch).toMatchObject({ slug: "general", state: "active", agent_policy: "open", topic: "" });
    const p = await env.HUB_DB.prepare("SELECT kind, namespace_id FROM project WHERE id = ?").bind(ch.project_id).first();
    expect(p).toEqual({ kind: "channel", namespace_id: null });
    expect(await getChannelBySlug(env.HUB_DB, acme.id, "general")).toEqual(ch);
    expect(await getChannelById(env.HUB_DB, acme.id, ch.project_id)).toEqual(ch);
    expect((await listChannels(env.HUB_DB, acme.id, "active")).map((c) => c.slug)).toEqual(["general"]);
  });

  it("refuses bad names and names already taken by a project or namespace", async () => {
    const { acme, lead } = await world();
    const mk = (slug: string) => createChannel(env.HUB_DB, { tenant_id: acme.id, slug, display_name: slug, topic: "", created_by: lead.identity.id }, Date.now());
    await expect(mk("no spaces")).rejects.toThrow(/invalid channel name/);
    await mk("general");
    await expect(mk("general")).rejects.toThrow(/taken/);
    await env.HUB_DB.prepare("INSERT INTO namespace (id, tenant_id, slug, display_name, state, created_at) VALUES ('n1', ?, 'research', 'R', 'active', 0)").bind(acme.id).run();
    await expect(mk("research")).rejects.toThrow(/namespace/);
    await expect(createChannel(env.HUB_DB, { tenant_id: acme.id, slug: "x", display_name: "x", topic: "t".repeat(251), created_by: lead.identity.id }, Date.now())).rejects.toThrow(/topic/);
  });

  it("updates topic, policy, and state", async () => {
    const { acme, lead } = await world();
    const ch = await createChannel(env.HUB_DB, { tenant_id: acme.id, slug: "general", display_name: "General", topic: "", created_by: lead.identity.id }, Date.now());
    await setChannelTopic(env.HUB_DB, acme.id, ch.project_id, "daily work");
    await setAgentPolicy(env.HUB_DB, acme.id, ch.project_id, "mention_only");
    expect(await setChannelState(env.HUB_DB, acme.id, ch.project_id, "archived")).toBe(true);
    expect(await setChannelState(env.HUB_DB, acme.id, ch.project_id, "archived")).toBe(false);
    expect(await getChannelById(env.HUB_DB, acme.id, ch.project_id)).toMatchObject({ topic: "daily work", agent_policy: "mention_only", state: "archived" });
  });

  it("adds, lists, and removes agent members, and re-adds after removal", async () => {
    const { acme, lead } = await world();
    const ch = await createChannel(env.HUB_DB, { tenant_id: acme.id, slug: "general", display_name: "General", topic: "", created_by: lead.identity.id }, Date.now());
    const scout = await seedAgent(acme, lead.identity, "scout");
    const add = () => addAgentMember(env.HUB_DB, { conversation_id: ch.project_id, tenant_id: acme.id, identity_id: scout.agent.identity.id, added_by: lead.identity.id }, Date.now());
    expect(await add()).toBe(true);
    expect(await add()).toBe(false);
    expect(await isAgentMember(env.HUB_DB, ch.project_id, scout.agent.identity.id)).toBe(true);
    expect(await listAgentMembers(env.HUB_DB, ch.project_id)).toEqual([{ identity_id: scout.agent.identity.id, operator_id: lead.identity.id }]);
    expect([...(await agentConversationIds(env.HUB_DB, acme.id, scout.agent.identity.id))]).toEqual([ch.project_id]);
    expect(await removeAgentMember(env.HUB_DB, ch.project_id, scout.agent.identity.id, Date.now())).toBe(true);
    expect(await isAgentMember(env.HUB_DB, ch.project_id, scout.agent.identity.id)).toBe(false);
    expect(await listAgentMembers(env.HUB_DB, ch.project_id)).toEqual([]);
    expect(await add()).toBe(true);
  });

  it("keeps the kill switch and mutes", async () => {
    const { acme, lead } = await world();
    const scout = await seedAgent(acme, lead.identity, "scout");
    const now = Date.now();
    expect(await getControls(env.HUB_DB, acme.id, now)).toEqual({ agents_enabled: true, muted: [] });
    await setAgentsEnabled(env.HUB_DB, acme.id, false, lead.identity.id, "test", now);
    await setAgentMute(env.HUB_DB, acme.id, scout.agent.identity.id, now + 60_000, lead.identity.id, "test");
    expect(await getControls(env.HUB_DB, acme.id, now)).toEqual({ agents_enabled: false, muted: [scout.agent.identity.id] });
    expect(await getControls(env.HUB_DB, acme.id, now + 61_000)).toEqual({ agents_enabled: false, muted: [] });
    await setAgentMute(env.HUB_DB, acme.id, scout.agent.identity.id, MUTE_FOREVER, null, "tripwire");
    expect(await agentMutedUntil(env.HUB_DB, acme.id, scout.agent.identity.id, now)).toBe(MUTE_FOREVER);
    await setAgentMute(env.HUB_DB, acme.id, scout.agent.identity.id, null, lead.identity.id, "unmute");
    expect(await agentMutedUntil(env.HUB_DB, acme.id, scout.agent.identity.id, now)).toBeNull();
  });
});
