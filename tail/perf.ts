// Native invocation timings, joined to the content-free marker emitted by the measured Worker.
export function writeInvocation(env: { PERF?: AnalyticsEngineDataset }, event: TraceItem): void {
  if (!env.PERF || !["pimwell-hub", "pimwell-git"].includes(event.scriptName ?? "")) return;
  let marker: Record<string, unknown> = {};
  for (const log of event.logs) {
    const line = log.message?.[0];
    if (typeof line !== "string" || line.length > 4096) continue;
    try {
      const decoded = JSON.parse(line);
      if (decoded.msg === "perf" && /^[0-9a-f-]{36}$/.test(decoded.request) && (decoded.tenant === "" || /^[0-9a-f]{32}$/.test(decoded.tenant))) { marker = decoded; break; }
    } catch { /* unrelated log */ }
  }
  const bounded = (key: string, length = 128) => typeof marker[key] === "string" ? String(marker[key]).slice(0,length) : "";
  const version = event.scriptVersion?.id ?? "unknown";
  try {
    env.PERF.writeDataPoint({ indexes: [`invocation:${bounded("request", 36) || crypto.randomUUID()}`],
      blobs: ["pimwell.com", event.scriptName ?? "unknown", version, bounded("colo", 8), bounded("tenant", 32), bounded("request", 36), marker.synthetic === true ? "synthetic" : "invocation",
        bounded("route"), bounded("method", 64), typeof marker.status === "number" ? `${Math.floor(marker.status/100)}xx` : "", bounded("auth", 16), bounded("verb", 64), bounded("tool", 64), "invocation", "", "", "", ""],
      doubles: [event.wallTime ?? -1, +(marker.cold === true), 0, Number.isSafeInteger(marker.parent) ? Number(marker.parent) : 0, +(event.outcome !== "ok"), 0, 0, 0, 0, -1, 1, event.cpuTime ?? -1, event.wallTime ?? -1, 1],
    });
  } catch { /* telemetry must not disrupt exception delivery */ }
}
