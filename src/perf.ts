import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./env";

export type Meter = { trips: number; statements: number; ms: number };
export type TimingSpan = {
  name: string; id: number; parent: number; ms: number; failed: boolean; started?: number; finished?: boolean;
  fingerprint?: string; execution?: number; read?: number; written?: number; region?: string; primary?: boolean;
  provider?: string; model?: string; firstToken?: number;
};
export type Trace = {
  id: string; parent: number; kind: "request" | "rpc"; started: number; cold: boolean; spans: TimingSpan[]; next: number; other: number; otherMs: number; otherOpen: number; otherStarted: number;
  route: string; method: string; auth: string; verb: string; tool: string; tenant: string; colo: string; status: number; ended?: number; pending: Set<Promise<unknown>>;
};
const context = new AsyncLocalStorage<{ trace: Trace; parent: number; entry?: TimingSpan }>();
let cold = true;
export function newTrace(method = "", colo = ""): Trace {
  const trace: Trace = { id: crypto.randomUUID(), parent: 0, kind: "request", started: performance.now(), cold, spans: [], next: crypto.getRandomValues(new Uint32Array(1))[0]! * 1_000_000, other: 0, otherMs: 0, otherOpen: 0, otherStarted: 0,
    route: "", method, auth: "anonymous", verb: "", tool: "", tenant: "", colo, status: 200, pending: new Set() };
  cold = false;
  return trace;
}
export function withTrace<T>(trace: Trace, fn: () => T): T { return context.run({ trace, parent: trace.parent }, fn); }
export function traceColo(): string { return context.getStore()?.trace.colo ?? ""; }
export function traceFields(fields: Partial<Pick<Trace, "route" | "auth" | "verb" | "tool" | "tenant">>): void {
  const current = context.getStore();
  if (current) Object.assign(current.trace, fields);
}
export function spanFields(fields: Partial<TimingSpan>): void {
  const current = context.getStore();
  if (current?.entry) Object.assign(current.entry, fields);
}
/** Only code-defined names; arguments/results never enter telemetry. Async context isolates concurrent requests. */
const instrumented = new WeakSet<Function>();
export function hasSpan(fn: Function): boolean { return instrumented.has(fn); }
export function spanFunction<F extends (...args: any[]) => any>(name: string, fn: F): F {
  const wrapped = ((...args: Parameters<F>) => span(name, () => fn(...args))) as F;
  instrumented.add(wrapped);
  return wrapped;
}
export function span<T>(name: string, fn: () => T): T {
  const current = context.getStore();
  if (!current) return fn();
  const { trace } = current;
  const started = performance.now(), id = ++trace.next;
  const entry: TimingSpan = { name, id, parent: current.parent, ms: 0, failed: false, started, finished: false };
  const retained = trace.spans.length < 199;
  if (retained) trace.spans.push(entry);
  else { trace.other++; trace.otherOpen++; trace.otherStarted += started; }
  const finish = (failed: boolean) => {
    entry.ms ||= performance.now() - started; entry.failed = failed; entry.finished = true;
    if (!retained) { trace.otherMs += entry.ms; trace.otherOpen--; trace.otherStarted -= started; }
  };
  try {
    const result = context.run({ trace, parent: id, entry }, fn);
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
      const promise = Promise.resolve(result).then(
        value => { finish(false); trace.pending.delete(promise); return value; },
        error => { finish(true); trace.pending.delete(promise); throw error; });
      trace.pending.add(promise);
      return promise as T;
    }
    finish(false); return result;
  } catch (error) { finish(true); throw error; }
}

const REAL = new WeakMap<object, D1PreparedStatement>();
const SQL = new WeakMap<object, string>();
const fingerprints = new Map<string, string>();
const normalizedSQL = new Map<string, string>();
function fingerprint(sql: string, caller?: Function): string {
  // Literal values and comments are discarded before hashing. No SQL text is exported.
  let normalized = normalizedSQL.get(sql);
  if (!normalized) {
    normalized = sql.replace(/'(?:''|[^'])*'|\b\d+(?:\.\d+)?\b/g, "?").replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (normalizedSQL.size >= 512) normalizedSQL.clear();
    normalizedSQL.set(sql, normalized);
  }
  // Call site is a code stack frame, never request data. Cache hashing, not the call site.
  let site = "unknown";
  if (caller && typeof Error.captureStackTrace === "function") {
    const holder: { stack?: string } = {}, limit = Error.stackTraceLimit;
    // Synchronous and restored before any user code/I/O: capture only the SQL caller, not a full expensive stack.
    try { Error.stackTraceLimit = 1; Error.captureStackTrace(holder, caller); site = holder.stack?.split("\n")[1]?.trim() ?? site; }
    finally { Error.stackTraceLimit = limit; }
  } else site = new Error().stack?.split("\n")[3]?.trim() ?? site;
  const key = normalized + site;
  let value = fingerprints.get(key);
  if (!value) {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    value = (hash >>> 0).toString(16).padStart(8, "0");
    if (fingerprints.size >= 512) fingerprints.clear();
    fingerprints.set(key, value);
  }
  return value;
}
function d1Meta(result: unknown): void {
  const results = Array.isArray(result) ? result : [result];
  let execution = 0, read = 0, written = 0, known = false; let region = "", primary = false;
  for (const r of results) {
    const meta = (r as D1Result | undefined)?.meta;
    if (!meta) continue;
    known = true;
    execution += meta.duration ?? 0; read += meta.rows_read ?? 0; written += meta.rows_written ?? 0;
    region = meta.served_by_region ?? region; primary ||= meta.served_by_primary ?? false;
  }
  spanFields({ execution: known ? execution : -1, read: known ? read : -1, written: known ? written : -1, region, primary });
}
function meteredStatement(stmt: D1PreparedStatement, m: Meter, key: string): D1PreparedStatement {
  const wrapped = new Proxy(stmt, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (prop === "bind") return (...args: unknown[]) => meteredStatement(target.bind(...args), m, key);
      if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
        return (...args: unknown[]) => span(`d1.${String(prop)}`, async () => {
          spanFields({ fingerprint: key });
          const t = performance.now();
          try {
            // first omits meta: execute all once and project the result locally.
            if (prop === "first") {
              const result = await target.all<Record<string, unknown>>(); d1Meta(result);
              const row = result.results[0] ?? null;
              if (args[0] === undefined) return row;
              if (row && !(String(args[0]) in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found`);
              return row?.[String(args[0])] ?? null;
            }
            const result = await v.apply(target, args); d1Meta(result); return result;
          } finally { m.trips++; m.statements++; m.ms += performance.now() - t; }
        });
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  REAL.set(wrapped, stmt); SQL.set(wrapped, key);
  return wrapped;
}
export function meteredD1(db: D1Database, m: Meter): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (prop === "prepare") return function prepare(sql: string) { return meteredStatement(target.prepare(sql), m, fingerprint(sql, prepare)); };
      if (prop === "withSession") return (...args: unknown[]) => meteredD1(Reflect.apply(v, target, args), m);
      if (prop === "batch") return (stmts: D1PreparedStatement[]) => span("d1.batch", async () => {
        const t = performance.now();
        try {
          const results = await target.batch(stmts.map(s => REAL.get(s) ?? s)); d1Meta(results);
          const elapsed = performance.now() - t;
          for (let i = 0; i < stmts.length; i++) {
            // Statement metadata shares the measured batch trip; no fictitious individual round trips.
            span("d1.statement", () => { spanFields({ fingerprint: SQL.get(stmts[i]!) ?? "unknown", ms: elapsed }); d1Meta(results[i]); });
          }
          return results;
        } finally { m.trips++; m.statements += stmts.length; m.ms += performance.now() - t; }
      });
      if (prop === "exec") return (sql: string) => span("d1.exec", async () => {
        spanFields({ fingerprint: fingerprint(sql) });
        const t = performance.now();
        try { return await target.exec(sql); } finally { m.trips++; m.statements++; m.ms += performance.now() - t; }
      });
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
export function serverTiming(appMs: number, m: Meter, trace?: Trace): string {
  const top = trace?.spans.map(s => ({ ...s, ms: s.finished === false ? performance.now() - s.started! : s.ms })).sort((a,b) => b.ms - a.ms).slice(0,8) ?? [];
  return `app;dur=${appMs.toFixed(1)}, db;desc="${m.trips} round trips, ${m.statements} statements";dur=${m.ms.toFixed(1)}` +
    top.map((s,i) => `, span${i};desc="${s.name.replace(/[^a-zA-Z0-9_.:/-]/g,"_")}";dur=${s.ms.toFixed(1)}`).join("");
}

type Transfer = { __pimwell_perf: 1; request: string; parent: number; route: string; method: string; auth: string; tenant: string; colo: string };
function transfer(): Transfer | null {
  const current = context.getStore();
  if (!current) return null;
  const t = current.trace;
  return { __pimwell_perf: 1, request: t.id, parent: current.parent, route: t.route, method: t.method, auth: t.auth, tenant: t.tenant, colo: t.colo };
}
function validTransfer(value: unknown): value is Transfer {
  const v = value as Transfer | null;
  return !!v && v.__pimwell_perf === 1 && typeof v.request === "string" && /^[0-9a-f-]{36}$/.test(v.request) && Number.isSafeInteger(v.parent)
    && ["route", "method", "auth", "tenant", "colo"].every(k => typeof (v as unknown as Record<string, unknown>)[k] === "string");
}
export function transferredTrace(request: Request): Trace {
  const trace = newTrace(request.method, String(request.cf?.colo ?? ""));
  try {
    const t: unknown = JSON.parse(request.headers.get("x-pimwell-perf") ?? "null");
    if (validTransfer(t)) inheritTrace(trace, t);
  } catch { /* absent/invalid internal transport */ }
  return trace;
}
function inheritTrace(trace: Trace, t: Transfer): void {
  Object.assign(trace, { id: t.request, parent: t.parent, kind: "rpc", route: t.route, method: t.method, auth: t.auth, tenant: t.tenant, colo: t.colo });
}
function forwardedFetch(args: unknown[]): unknown[] {
  const t = transfer();
  if (!t) return args;
  const request = args[0] instanceof Request ? args[0] : new Request(args[0] as RequestInfo, args[1] as RequestInit);
  const headers = new Headers(request.headers);
  headers.set("x-pimwell-perf", JSON.stringify(t));
  return [new Request(request, { headers })];
}
function timedStub<T extends object>(stub: T, prefix: string): T {
  return new Proxy(stub, { get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (typeof value !== "function" || typeof prop !== "string") return value;
    return (...args: unknown[]) => span(prefix + "." + prop, () => {
      const t = transfer();
      return Reflect.apply(value, target, prop === "fetch" ? forwardedFetch(args) : t ? [...args, t] : args);
    });
  } });
}
/** Binding wrappers preserve receivers and never examine keys, bodies or URLs. */
export function timedBinding<T extends object>(binding: T, prefix: string): T {
  return new Proxy(binding, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => span(`${prefix}.${String(prop)}`, () => Reflect.apply(value, target,
        prefix === "GIT_PROXY" && prop === "fetch" ? forwardedFetch(args) : args));
    },
  });
}
function timedNamespace<T extends object>(binding: T, name: string): T {
  return new Proxy(binding, { get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (typeof value !== "function") return value;
    if (prop === "get" || prop === "getByName") return (...args: unknown[]) => timedStub(value.apply(target, args), `do.stub.${name}`);
    return value.bind(target);
  } });
}
export function timedEnv<T extends Env>(env: T): T {
  const copy = { ...env, HUB_DB: meteredD1(env.HUB_DB, { trips: 0, statements: 0, ms: 0 }) };
  for (const key of ["RATE", "OAUTH_KV", "MAIL", "GIT_PUSH_STAGING", "GIT_PROXY", "ARDI"] as const) {
    const value = env[key];
    if (value) Object.assign(copy, { [key]: timedBinding(value, key) });
  }
  for (const key of ["CONVERSATION", "INBOX"] as const) if (env[key]) Object.assign(copy, { [key]: timedNamespace(env[key], key) });
  return copy;
}
const originalFetch = globalThis.fetch;
let fetchInstalled = false;
export function installFetchTiming(): void {
  if (fetchInstalled) return;
  fetchInstalled = true;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
    return span(`fetch.${host}`, () => originalFetch(input, init));
  }) as typeof fetch;
}

const tenantHashes = new Map<string, string>();
async function tenantHash(tenant: string, secret: string): Promise<string> {
  if (!tenant || !secret) return "";
  const cacheKey = secret + ":" + tenant;
  const cached = tenantHashes.get(cacheKey);
  if (cached) return cached;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const hash = await crypto.subtle.sign("HMAC", key, enc.encode(tenant));
  const result = Array.from(new Uint8Array(hash).slice(0,16), x => x.toString(16).padStart(2,"0")).join("");
  // Native I/O promises belong to an invocation/DO: cache plain values only.
  if (tenantHashes.size >= 256) tenantHashes.clear();
  tenantHashes.set(cacheKey, result);
  return result;
}
/** Called via waitUntil after dispatch. Analytics delivery must never fail a request. */
export async function writeTrace(env: Pick<Env, "PERF" | "WORKER_VERSION" | "PERF_TENANT_KEY" | "HUB_INTERNAL_SECRET" | "HUB_SECRETS_KEY">, trace: Trace, worker = "pimwell-hub", site = "pimwell.com"): Promise<void> {
  if (!env.PERF) return;
  try {
    const tenant = await tenantHash(trace.tenant, env.PERF_TENANT_KEY ?? env.HUB_INTERNAL_SECRET ?? env.HUB_SECRETS_KEY ?? "");
    const version = env.WORKER_VERSION?.id ?? "unknown", snapshot = performance.now();
    const write = (kind: string, s: TimingSpan) => env.PERF!.writeDataPoint({
      indexes: [version],
      blobs: [site, worker, version, trace.colo, tenant, trace.id, kind, trace.route, trace.method, `${Math.floor(trace.status/100)}xx`, trace.auth,
        trace.verb, trace.tool, s.name, s.fingerprint ?? "", s.region ?? "", s.provider ?? "", s.model ?? ""],
      doubles: [s.finished === false ? snapshot - s.started! : s.ms, +trace.cold, s.id, s.parent, +s.failed, s.execution ?? -1, s.read ?? -1, s.written ?? -1, s.primary === undefined ? -1 : +s.primary, s.firstToken ?? -1, kind === "other" ? trace.other : 1, 0, 0, s.finished === false ? 0 : 1],
    });
    write(trace.kind, { name: "request", id: 0, parent: trace.parent, ms: (trace.ended ?? performance.now())-trace.started, failed: trace.status >= 500 });
    for (const s of trace.spans) write("span", s);
    if (trace.other) {
      const ended = snapshot;
      const ms = trace.otherMs + trace.otherOpen * ended - trace.otherStarted;
      write("other", { name: "other", id: trace.next+1, parent: 0, ms, started: ended-ms, finished: trace.otherOpen === 0, failed: false });
    }
    console.log(JSON.stringify({ msg: "perf", request: trace.id, parent: trace.parent, tenant, colo: trace.colo, cold: trace.cold, route: trace.route, method: trace.method, auth: trace.auth, status: trace.status, verb: trace.verb, tool: trace.tool }));
  } catch { /* best-effort telemetry */ }
}
export async function deferredTrace(env: Parameters<typeof writeTrace>[0], trace: Trace, worker = "pimwell-hub", settleMs = 25_000): Promise<void> {
  if (!env.PERF) return;
  // MCP bodies/background turns can outlive dispatch. Drain off-response, within
  // waitUntil\u0027s lifetime; never delay/cancel product work or leave a timer behind.
  await scheduler.wait(0);
  if (trace.pending.size) {
    const abort = new AbortController();
    let expired = false;
    const deadline = scheduler.wait(Math.min(25_000, Math.max(0, settleMs)), { signal: abort.signal })
      .then(() => { expired = true; }, () => {});
    try {
      while (trace.pending.size && !expired) {
        await Promise.race([Promise.allSettled([...trace.pending]), deadline]);
        await scheduler.wait(0);
      }
    } finally { abort.abort(); }
  }
  await writeTrace(env, trace, worker);
}
export async function tracedInvocation<T>(env: Env, waitUntil: (p: Promise<unknown>) => void, name: string, fn: (env: Env) => Promise<T>, worker = "pimwell-hub"): Promise<T> {
  const trace = newTrace(name); trace.route = name;
  return withTrace(trace, async () => {
    try { return await span(name, () => fn(timedEnv(env))); }
    catch (error) { trace.status = 500; throw error; }
    finally { trace.ended = performance.now(); waitUntil(deferredTrace(env, trace, worker)); }
  });
}
/** Storage and handler wrappers are installed once, not on individual call sites. */
export function timedStorage(raw: DurableObjectStorage, name: string): DurableObjectStorage {
  const sql = timedBinding(raw.sql, `do.sql.${name}`);
  const storage = timedBinding(raw, `do.storage.${name}`);
  return new Proxy(storage, { get(target, prop) {
    return prop === "sql" ? sql : Reflect.get(target, prop, target);
  } });
}
export function instrumentMethods(klass: { prototype: object }, prefix: string): void {
  for (const method of Object.getOwnPropertyNames(klass.prototype)) {
    if (method === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(klass.prototype, method)!;
    if (typeof descriptor.value !== "function") continue;
    const original = descriptor.value;
    const value = function(this: unknown, ...args: unknown[]) { return span(`${prefix}.${method}`, () => Reflect.apply(original, this, args)); };
    instrumented.add(value);
    Object.defineProperty(klass.prototype, method, { ...descriptor, value });
  }
}
export function instrumentDurableObject(klass: { prototype: object }, name: string): void {
  for (const method of Object.getOwnPropertyNames(klass.prototype)) {
    if (method === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(klass.prototype, method)!;
    if (typeof descriptor.value !== "function") continue;
    const original = descriptor.value;
    Object.defineProperty(klass.prototype, method, { ...descriptor, value: function(this: { env: Env; ctx: DurableObjectState }, ...args: unknown[]) {
      const last = args.at(-1), request = args[0] instanceof Request ? args[0] : null;
      const inherited = validTransfer(last) ? last : null;
      if (inherited) args = args.slice(0, -1);
      if (context.getStore() && !inherited && !request) return span(`do.handler.${name}.${method}`, () => original.apply(this, args));
      const trace = request ? transferredTrace(request) : newTrace(`do.handler.${name}.${method}`);
      if (inherited) inheritTrace(trace, inherited);
      else if (!request) { trace.kind = "rpc"; trace.route = `do.handler.${name}.${method}`; }
      return withTrace(trace, async () => {
        try { return await span(`do.handler.${name}.${method}`, () => {
        const request = args[0] instanceof Request ? args[0] : null;
        const socket = args[0] instanceof WebSocket ? args[0].deserializeAttachment() as { tenant?: string; perfColo?: string } | null : null;
        if (socket?.perfColo) trace.colo = socket.perfColo;
        const input = args[0] as { tenant_id?: string } | null;
        traceFields({ tenant: typeof args[0] === "string" ? args[0] : typeof input?.tenant_id === "string" ? input.tenant_id : socket?.tenant ?? request?.headers.get("x-chat-tenant") ?? trace.tenant });
        return original.apply(this, args);
        }); }
        catch (error) { trace.status = 500; throw error; }
        finally { trace.ended = performance.now(); this.ctx.waitUntil(deferredTrace(this.env, trace)); }
      });
    } });
    instrumented.add(Object.getOwnPropertyDescriptor(klass.prototype, method)!.value);
  }
}
