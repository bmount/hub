import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { bindOnce } from "./bound";

export class Conversation extends DurableObject<Env> {
  async head(tenant_id: string, conversation_id: string): Promise<number> {
    bindOnce(this.ctx.storage.sql, tenant_id, conversation_id);
    return 0;
  }
}
