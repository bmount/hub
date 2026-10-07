// Per-request D1 metering for Server-Timing (overnight plan 2, N4). Each request gets its own wrapped binding, so
// concurrent requests never share a counter. A batch is one round trip; its statements are counted separately.

export type Meter = { trips: number; statements: number; ms: number };

const REAL = new WeakMap<object, D1PreparedStatement>();

function meteredStatement(stmt: D1PreparedStatement, m: Meter): D1PreparedStatement {
  const wrapped = new Proxy(stmt, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop === "bind") return (...args: unknown[]) => meteredStatement((v as (...a: unknown[]) => D1PreparedStatement).apply(target, args), m);
      if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
        return async (...args: unknown[]) => {
          const t = Date.now();
          try { return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args); }
          finally { m.trips++; m.statements++; m.ms += Date.now() - t; }
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  REAL.set(wrapped, stmt);
  return wrapped;
}

export function meteredD1(db: D1Database, m: Meter): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop === "prepare") return (sql: string) => meteredStatement(target.prepare(sql), m);
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          const t = Date.now();
          try { return await target.batch(stmts.map((s) => REAL.get(s) ?? s)); }
          finally { m.trips++; m.statements += stmts.length; m.ms += Date.now() - t; }
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export function serverTiming(appMs: number, m: Meter): string {
  return `app;dur=${appMs}, db;desc="${m.trips} round trips, ${m.statements} statements";dur=${m.ms}`;
}
