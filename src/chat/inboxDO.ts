import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { bindOnce } from "./bound";

export class Inbox extends DurableObject<Env> {
  async head(tenant_id: string, identity_id: string): Promise<number> {
    bindOnce(this.ctx.storage.sql, tenant_id, identity_id);
    return 0;
  }
}
