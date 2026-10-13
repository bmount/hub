import { updateAudience } from "../chat/updates";
import { conversationStub } from "../chat/stubs";
import { defineVerb } from "./table";
import { reqEnum, reqString } from "./params";
import { badRequest, forbidden, notFound } from "../errors";
import { people } from "../chat/handles";
import { requireContact } from "../chat/private";
import { openPrivateChat } from "../db/privateChat";
import { chatCommandText } from "../chat/compact";

export const chatOpen = defineVerb({
  name: "chat.open", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Open a fixed-membership private direct chat (2 participants) or group (2–20). Members are same-org @handles or identity IDs; you are always included. The same direct pair returns the same chat. Agents may open directs only with their operator or members who have messaged them, never groups or cold messages. Use the returned channel with existing chat tools.",
  formBack: (r) => `/c/${(r as { channel: string }).channel}`,
  mcp: { scope: "write", destructive: false, title: "Open a private chat", auditKeysOnly: true, render: chatCommandText,
    input: { type: "object", additionalProperties: false, required: ["kind", "members", "client_id"], properties: {
      kind: { type: "string", enum: ["direct", "group"] },
      members: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" }, description: "Same-org @handles or identity IDs. Caller is included automatically; duplicates collapse." },
      client_id: { type: "string", minLength: 1, maxLength: 64, description: "Persist a stable key and exact opening intent. Identical retries replay for 24 hours; changed intent conflicts." },
    } },
  },
  parse: (i) => {
    const members = typeof i.members === "string" ? i.members.split(/[\s,]+/).filter(Boolean) : i.members;
    if (!Array.isArray(members) || members.length < 1 || members.length > 20 || !members.every(m => typeof m === "string" && m.length > 0 && m.length <= 64)) throw badRequest("members must be 1–20 handles or identity IDs");
    return { kind: reqEnum(i, "kind", ["direct", "group"] as const), members: members as string[], client_id: reqString(i, "client_id", { max: 64 }) };
  },
  run: async (ctx, p) => {
    const me = ctx.identity!, tenant = ctx.tenant!.id;
    const dir = await people(ctx.db, tenant);
    if (!dir.get(me.id)?.active) throw forbidden("only active organization members may open private chats");
    const byHandle = new Map([...dir.values()].map(m => [m.handle, m]));
    const members = [...new Set([me.id, ...p.members.map(name => {
      const member = dir.get(name) ?? byHandle.get(name.replace(/^@/, "").toLowerCase());
      if (!member?.active) throw notFound("no such active member");
      return member.identity_id;
    })])].sort();
    if (members.length < 2 || members.length > 20 || (p.kind === "direct" && members.length !== 2)) throw badRequest("direct chats need 2 participants; groups need 2–20");
    if (me.kind === "agent") {
      if (p.kind !== "direct") throw forbidden("agents cannot initiate group chats");
      await requireContact(ctx, members.find(m => m !== me.id)!);
    }
    const { chat, replayed } = await openPrivateChat(ctx.db, tenant, me.id, p.kind, members, p.client_id, ctx.now);
    const audience = await updateAudience(ctx.db, tenant, chat.project_id);
    await conversationStub(ctx.env, tenant, chat.project_id).announceMembership(tenant, chat.project_id, chat.members, chat.created_at, audience);
    return { id: chat.project_id, kind: chat.kind, channel: chat.slug, members: chat.members, replayed };
  },
});
