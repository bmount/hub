// pimwell-tail: the Tail Worker apps in this Cloudflare account name as a tail consumer
// ("tail_consumers": [{ "service": "pimwell-tail" }]). It redacts each event (src/apps/redact.ts) and hands the batch
// to the hub over a service binding to its Ingest entrypoint. There is no HTTP route: nothing here is reachable from
// the internet, and the script name in each event is set by Cloudflare, not by the app.
import { redact, type AppEvent } from "../src/apps/redact";

interface Env {
  HUB: { events(batch: AppEvent[]): Promise<{ accepted: number; dropped: number }> };
}

export default {
  async tail(events: TraceItem[], env: Env): Promise<void> {
    const batch: AppEvent[] = [];
    for (const e of events.slice(0, 500)) {
      const r = redact(e as never);
      if (r) batch.push(r);
    }
    if (!batch.length) return;
    try {
      await env.HUB.events(batch);
    } catch (err) {
      // Never log the batch itself: only that delivery failed.
      console.error(JSON.stringify({ msg: "ingest failed", events: batch.length, error: err instanceof Error ? err.name : "error" }));
    }
  },
} satisfies ExportedHandler<Env>;
