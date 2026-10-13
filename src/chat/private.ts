import type { Ctx } from "../auth/context";
import { forbidden } from "../errors";
import { readableChannels, viewerOf } from "./access";
import { conversationStub } from "./stubs";

/** An agent may contact its current operator or a member who actually addressed it in an authorized conversation. */
export async function mayContact(ctx: Ctx, member: string): Promise<boolean> {
  if (ctx.identity!.kind !== "agent" || member === ctx.identity!.operator_id) return true;
  const v = viewerOf(ctx);
  const chats = [...await readableChannels(ctx.db, v), ...await readableChannels(ctx.db, v, "archived")];
  for (const chat of chats) {
    const privateChat = chat.kind === "direct" || chat.kind === "group";
    if (privateChat && !chat.members!.includes(member)) continue;
    if (await conversationStub(ctx.env, chat.tenant_id, chat.project_id).hasAddressedMessage(chat.tenant_id, chat.project_id, member, ctx.identity!.id, privateChat)) return true;
  }
  return false;
}

export async function requireContact(ctx: Ctx, member: string): Promise<void> {
  if (!(await mayContact(ctx, member))) throw forbidden("agents cannot cold-message members; contact your operator or a member who has messaged you");
}
