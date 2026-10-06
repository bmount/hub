import { defineVerb } from "./table";
import { optString, reqEnum, reqString } from "./params";
import { rank, type Ctx } from "../auth/context";
import { requireHuman } from "../auth/authority";
import { HubError, conflict, forbidden } from "../errors";
import { recordEvent } from "../db/events";
import {
  TOPIC_MAX, addAgentMember, createChannel, removeAgentMember, setAgentPolicy, setChannelState, setChannelTopic, type ChannelRow,
} from "../db/chat";
import { agentInTenant, readableChannel } from "../chat/access";

const POLICIES = ["open", "mention_only", "muted"] as const;
const OPEN_PROOF_MINUTES = 60;

async function channelEvent(ctx: Ctx, kind: string, ch: ChannelRow, summary: string): Promise<void> {
  await recordEvent(ctx.db, {
    tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session?.id ?? null, kind, target_kind: "channel", target_id: ch.project_id, summary,
  }, ctx.now);
}

function writable(ch: ChannelRow): void {
  if (ch.state !== "active") throw conflict("channel is archived");
}

export const channelCreate = defineVerb({
  name: "channel.create", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null, humanOnly: true,
  summary: "Create a channel. Every member can read it; agents join only when added.",
  parse: (i) => ({ slug: reqString(i, "slug", { max: 63 }), display_name: optString(i, "display_name", { max: 80 }), topic: optString(i, "topic", { max: TOPIC_MAX }) }),
  run: async (ctx, p) => {
    const { identity } = requireHuman(ctx);
    const ch = await createChannel(ctx.db, { tenant_id: ctx.tenant!.id, slug: p.slug, display_name: p.display_name ?? p.slug, topic: p.topic ?? "", created_by: identity.id }, ctx.now);
    await channelEvent(ctx, "channel.create", ch, `Created channel #${ch.slug}`);
    return { channel: { slug: ch.slug, display_name: ch.display_name, topic: ch.topic, agent_policy: ch.agent_policy } };
  },
});

export const channelSetTopic = defineVerb({
  name: "channel.set_topic", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null, humanOnly: true,
  summary: "Set a channel's topic.",
  parse: (i) => ({ c: reqString(i, "c", { max: 64 }), topic: optString(i, "topic", { max: TOPIC_MAX }) ?? "" }),
  run: async (ctx, p) => {
    requireHuman(ctx);
    const ch = await readableChannel(ctx, p.c);
    writable(ch);
    await setChannelTopic(ctx.db, ch.tenant_id, ch.project_id, p.topic);
    await channelEvent(ctx, "channel.set_topic", ch, `Set the topic of #${ch.slug}`);
    return { channel: ch.slug, topic: p.topic };
  },
});

async function agentMembership(ctx: Ctx, c: string, name: string, add: boolean) {
  const { identity } = requireHuman(ctx);
  const ch = await readableChannel(ctx, c);
  writable(ch);
  const agent = await agentInTenant(ctx, name);
  if (agent.identity.operator_id !== identity.id && rank(ctx.role) < rank("admin")) throw forbidden("only the agent's operator or an admin may do this");
  const changed = add
    ? await addAgentMember(ctx.db, { conversation_id: ch.project_id, tenant_id: ch.tenant_id, identity_id: agent.identity.id, added_by: identity.id }, ctx.now)
    : await removeAgentMember(ctx.db, ch.project_id, agent.identity.id, ctx.now);
  if (changed) await channelEvent(ctx, add ? "channel.add_agent" : "channel.remove_agent", ch, `${add ? "Added" : "Removed"} agent ${agent.slug} ${add ? "to" : "from"} #${ch.slug}`);
  return { channel: ch.slug, agent: agent.slug, ...(add ? { added: changed } : { removed: changed }) };
}

export const channelAddAgent = defineVerb({
  name: "channel.add_agent", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null, humanOnly: true,
  summary: "Let an agent read and post in a channel (its operator or an admin).",
  parse: (i) => ({ c: reqString(i, "c", { max: 64 }), agent: reqString(i, "agent", { max: 64 }) }),
  run: (ctx, p) => agentMembership(ctx, p.c, p.agent, true),
});

export const channelRemoveAgent = defineVerb({
  name: "channel.remove_agent", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null, humanOnly: true,
  summary: "Take an agent out of a channel (its operator or an admin).",
  parse: (i) => ({ c: reqString(i, "c", { max: 64 }), agent: reqString(i, "agent", { max: 64 }) }),
  run: (ctx, p) => agentMembership(ctx, p.c, p.agent, false),
});

export const channelSetAgentPolicy = defineVerb({
  name: "channel.set_agent_policy", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null, humanOnly: true,
  summary: "Set how agents may post in a channel: open, mention_only, or muted. Restricting needs no proof; opening needs an admin with fresh proof.",
  parse: (i) => ({ c: reqString(i, "c", { max: 64 }), policy: reqEnum(i, "policy", POLICIES) }),
  run: async (ctx, p) => {
    const { identity, session } = requireHuman(ctx);
    const ch = await readableChannel(ctx, p.c);
    writable(ch);
    const admin = rank(ctx.role) >= rank("admin");
    if (p.policy === "open") {
      if (!admin) throw forbidden("only an admin may open a channel to agents");
      // Spec 6.7: loosening always asks for proof (browser sessions; see dispatch.checkAccess).
      if (session.kind === "browser" && ctx.now - session.last_proof_at > OPEN_PROOF_MINUTES * 60_000) throw new HubError(403, "reproof_required");
    } else if (!admin && ch.created_by !== identity.id) {
      throw forbidden("only an admin or the channel's creator may restrict agents here");
    }
    await setAgentPolicy(ctx.db, ch.tenant_id, ch.project_id, p.policy);
    await channelEvent(ctx, "channel.set_agent_policy", ch, `Set agent policy of #${ch.slug} to ${p.policy}`);
    return { channel: ch.slug, agent_policy: p.policy };
  },
});

async function setState(ctx: Ctx, c: string, state: "active" | "archived") {
  const ch = await readableChannel(ctx, c);
  if (!(await setChannelState(ctx.db, ch.tenant_id, ch.project_id, state))) throw conflict(`channel already ${state}`);
  await channelEvent(ctx, state === "archived" ? "channel.archive" : "channel.unarchive", ch, `${state === "archived" ? "Archived" : "Unarchived"} #${ch.slug}`);
  return { channel: ch.slug, state };
}

export const channelArchive = defineVerb({
  name: "channel.archive", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60,
  summary: "Archive a channel: it stays readable and refuses posts.",
  parse: (i) => ({ c: reqString(i, "c", { max: 64 }) }),
  run: (ctx, p) => setState(ctx, p.c, "archived"),
});

export const channelUnarchive = defineVerb({
  name: "channel.unarchive", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60,
  summary: "Unarchive a channel.",
  parse: (i) => ({ c: reqString(i, "c", { max: 64 }) }),
  run: (ctx, p) => setState(ctx, p.c, "active"),
});
