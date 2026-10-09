// POST /internal/evals/intent on the hub's own host: runs the intent evals against the real model.
// - Guarded by the EVAL_KEY secret (a bearer, compared by hash); without the secret set, it doesn't exist.
// - Every model call is attributed to an active agent and a project named in the request (for example the agent
//   that records how Pimwell is built, in the Pimwell project), with client "intent-eval", so development usage is
//   never anonymous and no organization's name is written into the code.
// - Bounded: at most 60 cases per run, 10 runs an hour; larger models only when asked for by purpose.
import type { Env } from "../env";
import { classifyHost } from "../tenant";
import { sha256Hex } from "../ids";
import { takeRateDetail } from "../rate";
import { recordEvent } from "../db/events";
import { note } from "../log";
import { runIntentEvals } from "./evals";
import { HubError } from "../errors";
import { MAX_INTENT_EVAL_BODY_BYTES, readRequestBytes } from "../http/body";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function intentEvalRoute(request: Request, env: Env, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
  const host = classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN);
  if (host.kind !== "apex" || !env.EVAL_KEY) return json({ error: "not_found" }, 404);
  note(request, { verb: "eval.intent", via: "internal" });
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer || (await sha256Hex(bearer)) !== (await sha256Hex(env.EVAL_KEY))) return json({ error: "unauthorized" }, 401);
  const rate = await takeRateDetail(env.RATE, "eval_runs", "intent", Date.now(), waitUntil);
  if (!rate.ok) return json({ error: "too_many_requests" }, 429);
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = await readRequestBytes(request, MAX_INTENT_EVAL_BODY_BYTES); }
  catch (e) {
    if (e instanceof HubError) return json({ error: e.reason, detail: e.detail }, e.status);
    throw e;
  }
  let b: { attribute_to?: unknown; project?: unknown; purpose?: unknown; only?: unknown; max?: unknown };
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "bad_request", detail: "JSON object" }, 400);
    b = parsed as typeof b;
  } catch { return json({ error: "bad_request", detail: "JSON body" }, 400); }
  const purpose = typeof b.purpose === "string" && ["fast", "reasoning", "assistant", "deep"].includes(b.purpose) ? b.purpose : "fast";
  const who = typeof b.attribute_to === "string" ? b.attribute_to.trim().toLowerCase() : "";
  const agent = await env.HUB_DB.prepare(`SELECT i.id, m.tenant_id FROM identity i JOIN membership m ON m.identity_id = i.id AND m.state = 'active'
    WHERE i.email = ? AND i.kind = 'agent' AND i.state = 'active' LIMIT 1`).bind(who).first<{ id: string; tenant_id: string }>();
  if (!agent) return json({ error: "bad_request", detail: "attribute_to must be an active agent's address" }, 400);
  const project = typeof b.project === "string" && b.project ? await env.HUB_DB.prepare("SELECT id FROM project WHERE tenant_id = ? AND slug = ?").bind(agent.tenant_id, b.project).first<{ id: string }>() : null;
  if (typeof b.project === "string" && b.project && !project) return json({ error: "bad_request", detail: "no such project in the agent's organization" }, 400);
  const only = Array.isArray(b.only) ? b.only.filter((x): x is string => typeof x === "string").slice(0, 60) : undefined;
  const max = typeof b.max === "number" && b.max > 0 ? Math.min(60, Math.floor(b.max)) : 60;
  const r = await runIntentEvals(env, { purpose, only, max, attribution: { tenant_id: agent.tenant_id, identity_id: agent.id, project_id: project?.id ?? null } });
  await recordEvent(env.HUB_DB, { tenant_id: agent.tenant_id, identity_id: agent.id, session_id: null, kind: "eval.run", target_kind: "eval", target_id: "intent",
    summary: `Intent evals (${purpose}): ${r.passed} of ${r.passed + r.failed} passed` }, Date.now());
  return json(r);
}
