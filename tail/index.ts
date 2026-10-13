// pimwell-tail: the Tail Worker apps in this Cloudflare account name as a tail consumer
// ("tail_consumers": [{ "service": "pimwell-tail" }]). It redacts each event (src/apps/redact.ts) and hands the batch
// to the hub over a service binding to its Ingest entrypoint. There is no HTTP route: nothing here is reachable from
// the internet, and the script name in each event is set by Cloudflare, not by the app.
import { newTrace, withTrace, span, deferredTrace, timedBinding } from "../src/perf";
import { writeInvocation } from "./perf";
import { redact, type AppEvent } from "../src/apps/redact";
import { exceptionFingerprint } from "../src/apps/fingerprint";

interface Env {
  PERF?: AnalyticsEngineDataset;
  WORKER_VERSION?: { id: string; tag: string; timestamp: string };
  HUB: { events(batch: AppEvent[]): Promise<{ accepted: number; dropped: number }> };
}

async function deliver(events: TraceItem[], env: Env): Promise<void> {
    const batch: AppEvent[] = [];
    for (const e of events.slice(0, 500)) {
      writeInvocation(env, e);
      const r = redact(e as never);
      if (r) {
        for (let i = 0; i < r.exceptions.length; i++) {
          r.exceptions[i]!.fingerprint = await exceptionFingerprint(e.exceptions[i] as { name?: string; message?: string; stack?: string });
        }
        batch.push(r);
      }
    }
    if (!batch.length) return;
    try {
      await timedBinding(env.HUB, "tail.HUB").events(batch);
    } catch {
      // Never log the batch itself: only that delivery failed.
      console.error(JSON.stringify({ msg: "ingest failed", events: batch.length }));
    }
}
export default {
  async tail(events: TraceItem[], env: Env, ctx: ExecutionContext): Promise<void> {
    const trace = newTrace("tail"); trace.route = "tail";
    await withTrace(trace, async () => {
      try { await span("tail.deliver", () => deliver(events, env)); }
      catch (error) { trace.status = 500; throw error; }
      finally { trace.ended = performance.now(); ctx.waitUntil(deferredTrace(env, trace, "pimwell-tail")); }
    });
  },
} satisfies ExportedHandler<Env>;
