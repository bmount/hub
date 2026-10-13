#!/usr/bin/env node
// CPU-only tracer benchmark. Fake I/O removes service latency; native AE ingestion is not included.
// Node 24 can strip the TypeScript types. Run: node scripts/perf-overhead.mjs
import { newTrace, withTrace, span, traceFields, timedEnv, meteredD1, serverTiming, writeTrace } from "../src/perf.ts";
const result = { success: true, results: [{ n: 1 }], meta: { duration: 0.1, rows_read: 1, rows_written: 0, served_by_region: "ENAM", served_by_primary: true } };
const statement = { bind() { return this; }, async all() { return result; }, async run() { return result; } };
const db = { prepare() { return statement; }, async batch(statements) { return statements.map(() => result); } };
const env = { HUB_DB: db, PERF: { writeDataPoint() {} }, WORKER_VERSION: { id: "benchmark" }, HUB_INTERNAL_SECRET: "benchmark-only-key" };
async function request(traced, count) {
  const meter = { trips: 0, statements: 0, ms: 0 };
  const trace = traced ? newTrace("GET", "TEST") : null;
  const run = async () => {
    const binding = traced ? meteredD1(db, meter) : db;
    if (traced) traceFields({ tenant: "benchmark-tenant", route: "/:project/w/:number" });
    const rows = Array.from({ length: 12 }, (_, i) => binding.prepare(`SELECT n FROM fixture WHERE key = ? AND column${i} = ?`).bind(1, 2));
    await binding.batch(rows);
    for (let i = 0; i < count - 14; i++) traced ? span("render.fixture", () => i) : i;
  };
  if (traced) {
    await withTrace(trace, () => span("request", run));
    trace.ended = performance.now();
    serverTiming(trace.ended-trace.started, meter, trace);
    await writeTrace(env, trace);
  } else await run();
}
const log = console.log; console.log = () => {};
async function measure(traced, spans, iterations) {
  const start = process.cpuUsage();
  for (let i = 0; i < iterations; i++) await request(traced, spans);
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000 / iterations;
}
const rows = [];
try {
  for (const spans of [32, 200, 500]) {
    for (let i = 0; i < 200; i++) await request(true, spans);
    const baseline = await measure(false, spans, 2000), measured = await measure(true, spans, 2000);
    rows.push({ spans, iterations: 2000, baseline_cpu_ms: baseline, traced_cpu_ms: measured, overhead_cpu_ms: measured-baseline });
  }
} finally { console.log = log; }
console.log(JSON.stringify({ runtime: process.version, native_analytics_ingestion: false, measurements: rows }, null, 2));
if (rows.some(row => row.overhead_cpu_ms >= 1)) process.exitCode = 1;
