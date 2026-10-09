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
import { chatCommandText, plainText } from "../chat/compact";
import { cleanText, cutText } from "../mcp/render";

const channelInput = { type: "string", description: "An active channel you are already authorized to read. Does not join a channel." };

function presenceText(result: unknown): string {
  const r = result as { channel: string; observed_at: number; ttl_ms: number; entries: Array<Record<string, unknown>> };
  return plainText("Explicit channel presence snapshot", [
    JSON.stringify({ channel: r.channel, observed_at: r.observed_at, ttl_ms: r.ttl_ms }),
    "Missing is unknown; expired online/away is stale. Last seen means last explicit heartbeat, not reading or work. Offline is reported, not proven. Re-query for current state; cached snapshots expire after 90 seconds.",
    ...r.entries.map((e) => cleanText(JSON.stringify({ ...e,
      handle: cutText(cleanText(String(e.handle)), 64).text,
      display_name: cutText(cleanText(String(e.display_name)), 80).text,
    }))),
  ]);
}

async function activeChannel(ctx: Ctx, c: string) {
  const ch = await readableChannel(ctx, c);
  if (ch.state !== "active") throw notFound("no such active channel");
  return ch;
}

export const chatHeartbeat = defineVerb({
  name: "chat.heartbeat", kind: "command", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Explicitly publish your own online, away or offline status in an active channel. Heartbeats expire after 90 seconds; they do not prove work or reading.",
  mcp: {
    scope: "write", destructive: false, title: "Publish explicit channel heartbeat", auditKeysOnly: true, render: chatCommandText,
    input: { type: "object", additionalProperties: false, required: ["c", "status"], properties: {
      c: channelInput,
      status: { type: "string", enum: ["online", "away", "offline"], description: "Explicit reported status for the authenticated principal only. Renew online/away only while actually participating; expires in 90s. Assistant reports are labeled via-assistant, not evidence of human activity. A retry is a NEW heartbeat, not replay: after ambiguous delivery query presence instead of blindly retrying." },
    } },
  },
  parse: (i) => ({ c: channelParam(i), status: reqEnum(i, "status", ["online", "away", "offline"] as const) }),
  run: async (ctx, p) => {
    const ch = await activeChannel(ctx, p.c);
    const v = viewerOf(ctx);
    // Neither identity, timestamps nor TTL are caller-controlled. No implied heartbeat on reads/posts.
    const row = await conversationStub(ctx.env, ch.tenant_id, ch.project_id).heartbeat(ch.tenant_id, ch.project_id, v.identity.id, p.status, !!(ctx.oauth || ctx.playground));
    return { channel: ch.slug, ...row, ttl_ms: PRESENCE_TTL_MS };
  },
});

export const chatPresence = defineVerb({
  name: "chat.presence", kind: "query", scope: "tenant", minRole: "reader", freshProofMinutes: null,
  summary: "Read explicit recent heartbeats in one active channel. Expired heartbeats are stale, not proof of offline; missing entries are unknown.",
  mcp: {
    scope: "read", destructive: false, title: "Read channel presence", auditKeysOnly: true, render: presenceText,
    input: { type: "object", additionalProperties: false, required: ["c"], properties: { c: channelInput } },
  },
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
      return [{ identity_id: r.identity_id, handle: person.handle, display_name: person.display_name, kind: person.kind, via_assistant: r.via_assistant === true,
        state: presenceState(r, observed_at), last_seen: r.last_seen, expires_at: r.expires_at }];
    });
    return { channel: ch.slug, observed_at, entries, missing: "unknown", ttl_ms: PRESENCE_TTL_MS };
  },
});
