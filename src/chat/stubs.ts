import type { Env } from "../env";

export function conversationStub(env: Env, tenant_id: string, conversation_id: string) {
  return env.CONVERSATION.get(env.CONVERSATION.idFromName(`${tenant_id}:${conversation_id}`));
}

export function inboxStub(env: Env, tenant_id: string, identity_id: string) {
  return env.INBOX.get(env.INBOX.idFromName(`${tenant_id}:${identity_id}`));
}
