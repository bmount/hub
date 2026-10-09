import { defineVerb } from "./table";
import { reqEnum } from "./params";
import { channelParam } from "./chatParams";
import { readableChannel, viewerOf } from "../chat/access";
import { notFound } from "../errors";
import { listAgentMembers } from "../db/chat";
import { people } from "../chat/handles";
import { conversationStub } from "../chat/stubs";
import { presenceState, PRESENCE_TTL_MS, type PresenceRow } from "../chat/presence";
import type { Ctx } from "../auth/context";

async function activeChannel(ctx: Ctx, c: string) {
  const ch = await readableChannel(ctx, c);
  if (ch.state !== "active") throw notFound("no such active channel");
  return ch;
}

export const chatHeartbeat = defineVerb({
  name: "chat.heartbeat", kind: "command", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Explicitly publish your own online, away or offline status in an active channel. Heartbeats expire after 90 seconds; they do not prove work or reading.",
  parse: (i) => ({ c: channelParam(i), status: reqEnum(i, "status", ["online", "away", "offline"] as const) }),
  run: async (ctx, p) => {
    const ch = await activeChannel(ctx, p.c);
    const v = viewerOf(ctx);
    // Neither identity, timestamps nor TTL are caller-controlled. No implied heartbeat on reads/posts.
    const row = await conversationStub(ctx.env, ch.tenant_id, ch.project_id).heartbeat(ch.tenant_id, ch.project_id, v.identity.id, p.status);
    return { channel: ch.slug, ...row, ttl_ms: PRESENCE_TTL_MS };
  },
});

export const chatPresence = defineVerb({
  name: "chat.presence", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Read explicit recent heartbeats in one active channel. Expired heartbeats are stale, not proof of offline; missing entries are unknown.",
  parse: (i) => ({ c: channelParam(i) }),
  run: async (ctx, p) => {
    const ch = await activeChannel(ctx, p.c);
    const rows = await conversationStub(ctx.env, ch.tenant_id, ch.project_id).presence(ch.tenant_id, ch.project_id) as PresenceRow[];
    const dir = await people(ctx.db, ch.tenant_id);
    const agents = new Set((await listAgentMembers(ctx.db, ch.tenant_id, ch.project_id)).map((a) => a.identity_id));
    const observed_at = Date.now();
    // Recheck subjects too: old heartbeats cannot expose a removed member/agent's activity.
    const entries = rows.flatMap((r) => {
      const person = dir.get(r.identity_id);
      if (!person?.active || (person.kind === "agent" && !agents.has(person.identity_id))) return [];
      return [{ identity_id: r.identity_id, handle: person.handle, display_name: person.display_name, kind: person.kind,
        state: presenceState(r, observed_at), last_seen: r.last_seen, expires_at: r.expires_at }];
    });
    return { channel: ch.slug, observed_at, entries, missing: "unknown", ttl_ms: PRESENCE_TTL_MS };
  },
});
