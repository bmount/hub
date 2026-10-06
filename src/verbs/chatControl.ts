import { defineVerb } from "./table";
import { optInt, optString, reqString } from "./params";
import { rank, type Ctx } from "../auth/context";
import { requireHuman } from "../auth/authority";
import { forbidden } from "../errors";
import { recordEvent } from "../db/events";
import { MUTE_FOREVER, setAgentMute, setAgentsEnabled } from "../db/chat";
import { agentInTenant, readableChannels, viewerOf } from "../chat/access";
import { conversationStub, inboxStub } from "../chat/stubs";

async function controlEvent(ctx: Ctx, kind: string, target_kind: string, target_id: string, summary: string): Promise<void> {
  await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session?.id ?? null, kind, target_kind, target_id, summary }, ctx.now);
}

export const chatConversations = defineVerb({
  name: "chat.conversations", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "List the channels you can read, with each one's head and your read cursor.",
  parse: () => ({}),
  run: async (ctx) => {
    const v = viewerOf(ctx);
    const chans = await readableChannels(ctx.db, v, "active");
    const cursors = await inboxStub(ctx.env, v.tenant.id, v.identity.id).cursors(v.tenant.id, v.identity.id);
    const heads = await Promise.all(chans.map((c) => conversationStub(ctx.env, v.tenant.id, c.project_id).head(v.tenant.id, c.project_id)));
    return {
      conversations: chans.map((c, i) => ({
        channel: c.slug, display_name: c.display_name, topic: c.topic, agent_policy: c.agent_policy, head: heads[i]!, read_seq: cursors[c.project_id] ?? 0,
      })),
    };
  },
});

export const chatAgentMute = defineVerb({
  name: "chat.agent_mute", kind: "command", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Stop an agent posting and being woken anywhere in this tenant, optionally for some minutes (the agent itself, its operator, or an admin).",
  parse: (i) => ({ agent: reqString(i, "agent", { max: 64 }), minutes: optInt(i, "minutes", { min: 1, max: 10_080 }), reason: optString(i, "reason", { max: 200 }) }),
  run: async (ctx, p) => {
    const me = ctx.identity!;
    const agent = await agentInTenant(ctx, p.agent);
    const allowed = me.id === agent.identity.id || agent.identity.operator_id === me.id || rank(ctx.role) >= rank("admin");
    if (!allowed) throw forbidden("only the agent, its operator, or an admin may mute it");
    const until = p.minutes ? ctx.now + p.minutes * 60_000 : MUTE_FOREVER;
    await setAgentMute(ctx.db, ctx.tenant!.id, agent.identity.id, until, me.id, p.reason);
    await controlEvent(ctx, "chat.agent_mute", "identity", agent.identity.id, `Muted agent ${agent.slug}${p.minutes ? ` for ${p.minutes} min` : ""}`);
    return { agent: agent.slug, muted_until: until };
  },
});

export const chatAgentUnmute = defineVerb({
  name: "chat.agent_unmute", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: 60, humanOnly: true,
  summary: "Let a muted agent post again (its operator or an admin).",
  parse: (i) => ({ agent: reqString(i, "agent", { max: 64 }) }),
  run: async (ctx, p) => {
    const { identity } = requireHuman(ctx);
    const agent = await agentInTenant(ctx, p.agent);
    if (agent.identity.operator_id !== identity.id && rank(ctx.role) < rank("admin")) throw forbidden("only the agent's operator or an admin may unmute it");
    await setAgentMute(ctx.db, ctx.tenant!.id, agent.identity.id, null, identity.id, null);
    await controlEvent(ctx, "chat.agent_unmute", "identity", agent.identity.id, `Unmuted agent ${agent.slug}`);
    return { agent: agent.slug, muted_until: null };
  },
});

export const chatAgentsDisable = defineVerb({
  name: "chat.agents_disable", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: null,
  summary: "Tenant kill switch: no agent posts and no agent wakes until enabled again.",
  parse: (i) => ({ reason: optString(i, "reason", { max: 200 }) }),
  run: async (ctx, p) => {
    await setAgentsEnabled(ctx.db, ctx.tenant!.id, false, ctx.identity!.id, p.reason, ctx.now);
    await controlEvent(ctx, "chat.agents_disable", "tenant", ctx.tenant!.id, "Switched agent posting off");
    return { agents_enabled: false };
  },
});

export const chatAgentsEnable = defineVerb({
  name: "chat.agents_enable", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60,
  summary: "Switch agent posting and wakes back on.",
  parse: () => ({}),
  run: async (ctx) => {
    await setAgentsEnabled(ctx.db, ctx.tenant!.id, true, ctx.identity!.id, null, ctx.now);
    await controlEvent(ctx, "chat.agents_enable", "tenant", ctx.tenant!.id, "Switched agent posting on");
    return { agents_enabled: true };
  },
});
