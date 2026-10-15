import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { installFetchTiming, tracedInvocation, markHttpEntry } from "./perf";

export { Conversation } from "./chat/conversationDO";
export { Inbox } from "./chat/inboxDO";

// Object activation must not initialize the HTTP router and every verb.
installFetchTiming();

export default {
  async fetch(request: Request, env, ctx) {
    markHttpEntry(request);
    return (await import("./hub")).default.fetch(request, env, ctx);
  },
  async email(message, env, ctx) {
    return (await import("./hub")).default.email(message, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return (await import("./hub")).default.scheduled(event, env, ctx);
  },
} satisfies ExportedHandler<Env>;

/** Internal telemetry RPC, independent of the HTTP router. */
export class Ingest extends WorkerEntrypoint<Env> {
  async events(batch: unknown): Promise<{ accepted: number; dropped: number }> {
    const { ingest } = await import("./apps/ingest");
    return tracedInvocation(this.env, p => this.ctx.waitUntil(p), "rpc.ingest", e => ingest(e, batch, Date.now()));
  }
}
