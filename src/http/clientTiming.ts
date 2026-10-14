import type { Env } from "../env";
import { buildContext } from "../auth/context";
import { sameOrigin } from "./login";
import { readRequestBytes } from "./body";
import { takeRateDetail } from "../rate";
import { validClientPoint } from "../clientTiming";
import { writeClientPoints } from "../perf";

export async function clientTiming(request: Request, env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  const reply = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });
  // sendBeacon cannot add a custom header. Same-origin, browser-cookie auth and
  // strict JSON validation replace clientSlow's explicit client header.
  if (!sameOrigin(request)) return reply(403);
  const ctx = await buildContext(request, env, Date.now(), waitUntil);
  if (!ctx.identity || ctx.authKind !== "cookie" || ctx.session?.kind !== "browser" || (ctx.tenant && !ctx.role)) return reply(403);
  if (!(await takeRateDetail(env.RATE, "client_timing_session", ctx.session.id, ctx.now, waitUntil)).ok) return reply(429);
  let points: unknown;
  try { points = JSON.parse(new TextDecoder().decode(await readRequestBytes(request, 32768, 3000))); } catch { return reply(400); }
  if (!Array.isArray(points) || !points.length || points.length > 100 || !points.every(validClientPoint)) return reply(400);
  waitUntil(writeClientPoints(env, ctx.tenant?.id ?? "", String(request.cf?.colo ?? ""), points));
  return reply(204);
}
