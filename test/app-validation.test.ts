import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ingest } from "../src/apps/ingest";
import { redact, type AppEvent } from "../src/apps/redact";
import { APP_EVENT_AGE_MAX, APP_EVENT_FUTURE_MAX, APP_EVENT_BYTES_MAX, APP_BATCH_BYTES_MAX, validatedAppBatch, validatedAppEvent } from "../src/apps/validate";
import { createProject } from "../src/db/projects";
import { seedTenant } from "./helpers";
import type { Env } from "../src/env";

const event = (now = Date.now()): AppEvent => ({ script: "bounded-app", version: null, tag: null, message: null, at: now, outcome: "ok",
  method: "GET", path: "/test", status: 200, ray: null, logs: [], exceptions: [], usage: [] });
const usage = () => ({ provider: "openai", model: "synthetic", input_tokens: 10, output_tokens: 0, cached_tokens: null, cost_usd: null, purpose: null });
const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).byteLength;
function exactEvent(size: number, now: number): AppEvent {
  const e = event(now);
  e.logs = Array.from({ length: 10 }, () => ({ level: "warn" as const, text: "\u0000".repeat(1000) }));
  e.logs.push({ level: "warn", text: "" });
  const remainder = size - bytes(e);
  e.logs[10]!.text = "\u0000".repeat(Math.floor(remainder / 6)) + "x".repeat(remainder % 6);
  expect(bytes(e)).toBe(size);
  return e;
}
async function source() {
  const t = await seedTenant("bounded");
  const p = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "bounded", kind: "repo", display_name: "Synthetic app" }, Date.now());
  await env.HUB_DB.prepare("INSERT INTO app_source (id, tenant_id, project_id, script_name, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
    .bind("synthetic-source", t.id, p.id, "bounded-app", Date.now()).run();
  return { t, p };
}

describe("bounded nested RPC app telemetry validation", () => {
  it("validates every scalar and nested entry, dropping the whole malformed event", () => {
    const now = Date.now(), base = event(now);
    const invalid = [
      null, [], { ...base, script: "" }, { ...base, script: "x".repeat(101) }, { ...base, at: NaN }, { ...base, at: Infinity },
      { ...base, at: 0.5 }, { ...base, at: -1 }, { ...base, status: 99 }, { ...base, status: 600 }, { ...base, status: 200.5 },
      { ...base, status: "200" }, { ...base, outcome: null }, { ...base, version: {} }, { ...base, tag: 7 },
      { ...base, message: "x".repeat(202) }, { ...base, path: "x".repeat(302) }, { ...base, method: "x".repeat(12) }, { ...base, ray: false },
      { ...base, logs: [null] }, { ...base, logs: [{ level: "info", text: "ignored" }] }, { ...base, logs: [{ level: "error", text: {} }] },
      { ...base, logs: [{ level: "warn", text: "x".repeat(1002) }] }, { ...base, logs: Array(51).fill({ level: "warn", text: "" }) },
      { ...base, exceptions: [null] }, { ...base, exceptions: [{ name: "Error", message: 1 }] }, { ...base, exceptions: Array(21).fill({ name: "Error", message: "" }) },
      { ...base, usage: [null] }, { ...base, usage: Array(51).fill(usage()) }, { ...base, usage: [{ ...usage(), provider: "" }] },
      ...["input_tokens", "output_tokens", "cached_tokens"].flatMap((key) => [-1, NaN, Infinity, 0.5, 50_000_001, "10"].map((value) => ({ ...base, usage: [{ ...usage(), [key]: value }] }))),
      { ...base, usage: [{ ...usage(), cached_tokens: 11 }] }, { ...base, usage: [{ ...usage(), cost_usd: Infinity }] },
      { ...base, usage: [{ ...usage(), cost_usd: -1 }] }, { ...base, usage: [{ ...usage(), cost_usd: 10_001 }] },
      { ...base, usage: [{ ...usage(), purpose: "not a name" }] }, { ...base, usage: [{ ...usage(), model: "x".repeat(81) }] },
      { ...base, unknown_payload: "not retained" }, { ...base, logs: [{ level: "warn", text: "test", body: "not retained" }] },
      { ...base, usage: [{ ...usage(), prompt: "not retained" }] },
    ];
    for (const x of invalid) expect(validatedAppEvent(x, now)).toBeNull();
    expect(validatedAppEvent({ ...base, usage: [usage(), { ...usage(), cached_tokens: 0, cost_usd: 0 }] }, now)?.usage).toEqual([usage(), { ...usage(), cached_tokens: 0, cost_usd: 0 }]);
    expect(validatedAppEvent({ ...base, usage: [{ ...usage(), input_tokens: null }] }, now)).toBeNull(); // Not invented as zero.
  });

  it("copies allowed fields, permits source truncation caps, and enforces exact timestamp boundaries", () => {
    const now = Date.now(), e = event(now);
    e.logs.push({ level: "warn", text: "synthetic" }); e.usage.push(usage());
    const copy = validatedAppEvent(e, now)!;
    e.logs[0]!.text = "mutated"; e.usage[0]!.input_tokens = 20;
    expect(copy.logs[0]!.text).toBe("synthetic"); expect(copy.usage[0]!.input_tokens).toBe(10);
    for (const at of [now - APP_EVENT_AGE_MAX, now + APP_EVENT_FUTURE_MAX]) expect(validatedAppEvent({ ...event(now), at }, now)).not.toBeNull();
    for (const at of [now - APP_EVENT_AGE_MAX - 1, now + APP_EVENT_FUTURE_MAX + 1]) expect(validatedAppEvent({ ...event(now), at }, now)).toBeNull();
    const capped = redact({ scriptName: "bounded-app", eventTimestamp: now, scriptVersion: { id: "v".repeat(200), tag: "t".repeat(200), message: "m".repeat(300) },
      outcome: "o".repeat(100), logs: [{ level: "warn", message: ["l".repeat(2000)] }], exceptions: [{ name: "n".repeat(200), message: "e".repeat(2000) }] });
    expect(validatedAppEvent(capped, now)).toEqual(capped);
  });

  it("bounds actual UTF-8 JSON bytes per event and selected batch before any SQL", async () => {
    const now = Date.now();
    const exact = exactEvent(APP_EVENT_BYTES_MAX, now), overflow = exactEvent(APP_EVENT_BYTES_MAX + 1, now);
    expect(validatedAppEvent(exact, now)).toEqual(exact);
    expect(validatedAppEvent(overflow, now)).toBeNull();
    expect(validatedAppEvent({ ...event(now), logs: Array(50).fill({ level: "warn", text: "😀".repeat(500) }) }, now)).toBeNull();
    const batch = Array.from({ length: 16 }, () => exactEvent(APP_EVENT_BYTES_MAX, now));
    // Set the last event so the entire serialized array is exactly at its budget.
    batch[15] = exactEvent(APP_BATCH_BYTES_MAX - bytes(batch.slice(0, 15)) - 1, now);
    expect(bytes(batch)).toBe(APP_BATCH_BYTES_MAX);
    expect(validatedAppBatch(batch, now)).toHaveLength(16);
    batch[15]!.logs[10]!.text += "x";
    expect(bytes(batch)).toBe(APP_BATCH_BYTES_MAX + 1);
    expect(validatedAppBatch(batch, now)).toEqual([]);
    const noSql = { HUB_DB: { prepare() { throw new Error("unexpected SQL"); } } } as unknown as Env;
    expect(await ingest(noSql, batch, now)).toEqual({ accepted: 0, dropped: 16 });
    expect(await ingest(noSql, [overflow, { ...event(now), usage: [null] }], now)).toEqual({ accepted: 0, dropped: 2 });
  });

  it("does not let a malformed late event abort valid writes or poison nested usage and preserves exact original counts", async () => {
    await source(); const now = Date.now();
    const good = { ...event(now), logs: [{ level: "error" as const, text: "synthetic failure" }], usage: [usage()] };
    const bad = { ...event(now), logs: [null], usage: [usage()] };
    const result = await ingest(env, [good, null, { ...event(now), script: "unregistered" }, bad], now);
    expect(result).toEqual({ accepted: 1, dropped: 3 });
    expect(await env.HUB_DB.prepare("SELECT SUM(requests) AS n FROM app_stat").first()).toEqual({ n: 1 });
    expect(await env.HUB_DB.prepare("SELECT SUM(count) AS n FROM app_error_group").first()).toEqual({ n: 1 });
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n, SUM(input_tokens) AS tokens FROM model_call").first()).toEqual({ n: 1, tokens: 10 });
    expect(await ingest(env, [{ ...event(now), script: "unregistered" }, bad, null], now)).toEqual({ accepted: 0, dropped: 3 });
    expect(await ingest(env, Array.from({ length: 503 }, () => event(now)), now)).toEqual({ accepted: 500, dropped: 3 });
    expect(await env.HUB_DB.prepare("SELECT SUM(requests) AS n FROM app_stat").first()).toEqual({ n: 501 });
    expect(await ingest(env, [{ ...event(now), at: now - APP_EVENT_AGE_MAX - 1 }, { ...event(now), at: now + APP_EVENT_FUTURE_MAX + 1 }], now)).toEqual({ accepted: 0, dropped: 2 });
    expect(await env.HUB_DB.prepare("SELECT SUM(requests) AS n FROM app_stat").first()).toEqual({ n: 501 });
  });
});
