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

// Miniflare's SQLite may permit more variables than production D1. Enforce the
// production ceiling while executing every successful lookup against real D1.
function limitedLookups(fail?: "source" | "version" | "group") {
  const sizes = { source: [] as number[], version: [] as number[], group: [] as number[] };
  let writes = 0;
  const db = {
    prepare(sql: string) {
      const statement = env.HUB_DB.prepare(sql);
      return {
        bind(...values: unknown[]) {
          if (values.length > 100) throw new Error("D1 parameter limit exceeded");
          const bound = statement.bind(...values);
          const kind = sql.includes("WHERE s.script_name IN") ? "source" : sql.includes("WHERE version_id IN") ? "version" : sql.includes("WHERE fingerprint IN") ? "group" : null;
          if (!kind) return bound;
          sizes[kind].push(values.length);
          return { async all() {
            if (fail === kind && sizes[kind].length === 2) throw new Error("late lookup failed");
            return bound.all();
          } };
        },
      };
    },
    batch(statements: D1PreparedStatement[]) { writes++; return env.HUB_DB.batch(statements); },
  };
  return { env: { ...env, HUB_DB: db } as unknown as Env, sizes, writes: () => writes };
}
const letters = (n: number) => `${String.fromCharCode(97 + Math.floor(n / 26))}${String.fromCharCode(97 + n % 26)}`;

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

  it("chunks diverse source lookups without admitting unapproved or inactive sources", async () => {
    const { t, p } = await source(), now = Date.now();
    const scripts = ["bounded-app", ...Array.from({ length: 100 }, (_, i) => `active-${letters(i)}`)];
    for (const script of scripts.slice(1)) await env.HUB_DB.prepare("INSERT INTO app_source (id, tenant_id, project_id, script_name, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
      .bind(script, t.id, p.id, script, now).run();
    for (const state of ["pending", "disabled"]) await env.HUB_DB.prepare("INSERT INTO app_source (id, tenant_id, project_id, script_name, state, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(state, t.id, p.id, state, state, now).run();
    const archived = await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "archived", kind: "repo", display_name: "Archived" }, now);
    await env.HUB_DB.prepare("UPDATE project SET state = 'archived' WHERE id = ?").bind(archived.id).run();
    const other = await seedTenant("inactive");
    const otherProject = await createProject(env.HUB_DB, { tenant_id: other.id, namespace_id: null, slug: "inactive", kind: "repo", display_name: "Inactive" }, now);
    await env.HUB_DB.prepare("UPDATE tenant SET state = 'deleted' WHERE id = ?").bind(other.id).run();
    for (const [script, tenant, project] of [["archived", t.id, archived.id], ["inactive", other.id, otherProject.id]])
      await env.HUB_DB.prepare("INSERT INTO app_source (id, tenant_id, project_id, script_name, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)").bind(script, tenant, project, script, now).run();
    const selected = [...scripts, "pending", "disabled", "archived", "inactive", ...Array.from({ length: 395 }, (_, i) => `unknown-${letters(i)}`)];
    expect(selected).toHaveLength(500);
    const bounded = limitedLookups();
    expect(await ingest(bounded.env, [...selected, "bounded-app", "bounded-app", "bounded-app"].map((script) => ({ ...event(now), script })), now))
      .toEqual({ accepted: 101, dropped: 402 });
    expect(bounded.sizes).toEqual({ source: [100, 100, 100, 100, 100], version: [], group: [] });
    expect(await env.HUB_DB.prepare("SELECT SUM(requests) AS n FROM app_stat").first()).toEqual({ n: 101 });
    expect((await env.HUB_DB.prepare("SELECT script_name FROM app_stat").all<{ script_name: string }>()).results.map((r) => r.script_name).sort()).toEqual(scripts.sort());
    expect((await env.HUB_DB.prepare("SELECT script_name FROM app_source WHERE last_event_at IS NOT NULL").all()).results).toHaveLength(101);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM app_stat WHERE tenant_id != ?").bind(t.id).first()).toEqual({ n: 0 });
  });

  it("preserves known and new deploys and groups across every lookup chunk", async () => {
    await source(); const now = Date.now(), bounded = limitedLookups();
    const events = Array.from({ length: 500 }, (_, i) => ({ ...event(now), version: `version-${letters(i)}`,
      logs: [{ level: "warn" as const, text: `warning-${letters(i)}` }, { level: "error" as const, text: `failure-${letters(i)}` }] }));
    // These are separate occurrences, not a retry-idempotence assertion.
    expect(await ingest(bounded.env, events.slice(0, 101), now)).toEqual({ accepted: 101, dropped: 0 });
    expect(await ingest(bounded.env, events, now)).toEqual({ accepted: 500, dropped: 0 });
    expect(bounded.sizes.version).toEqual([100, 1, 100, 100, 100, 100, 100]);
    expect(bounded.sizes.group).toEqual([100, 100, 2, ...Array(10).fill(100)]);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM app_deploy").first()).toEqual({ n: 500 });
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n, SUM(count) AS occurrences FROM app_error_group").first()).toEqual({ n: 1000, occurrences: 1202 });
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM app_event").first()).toEqual({ n: 1202 });
    expect(await env.HUB_DB.prepare("SELECT SUM(requests) AS n FROM app_stat").first()).toEqual({ n: 601 });
    expect(await env.HUB_DB.prepare("SELECT count FROM app_error_group WHERE title = ?").bind("warning-aa").first()).toEqual({ count: 2 });
    expect(await env.HUB_DB.prepare("SELECT count FROM app_error_group WHERE title = ?").bind(`failure-${letters(499)}`).first()).toEqual({ count: 1 });
  });

  it.each(["source", "version", "group"] as const)("rejects a failed late %s lookup before any writes", async (kind) => {
    await source(); const now = Date.now(), bounded = limitedLookups(kind);
    const events = Array.from({ length: 101 }, (_, i) => ({ ...event(now),
      script: kind === "source" ? `script-${letters(i)}` : "bounded-app",
      version: kind === "version" ? `version-${letters(i)}` : null,
      logs: kind === "group" ? [{ level: "error" as const, text: `failure-${letters(i)}` }] : [],
    }));
    await expect(ingest(bounded.env, events, now)).rejects.toThrow("late lookup failed");
    expect(bounded.sizes[kind]).toEqual([100, 1]);
    expect(bounded.writes()).toBe(0);
    for (const table of ["app_stat", "app_deploy", "app_error_group", "app_event", "model_call"])
      expect(await env.HUB_DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).toEqual({ n: 0 });
    expect(await env.HUB_DB.prepare("SELECT last_event_at FROM app_source").first()).toEqual({ last_event_at: null });
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
