// The in-context MCP Playground (overnight plan 2, N1): run any MCP tool as an assistant would, inside the
// organization you are signed in to, with scopes you choose. It never widens authority:
//   - the organization is the host's, and nothing in a request can name another one;
//   - authority is the signed-in person's current role, narrowed by the chosen scopes, through the same exposure
//     and access checks as /mcp (toolsFor, callTool, checkAccess);
//   - only same-origin JSON POSTs carrying the Playground header, from a browser session, are accepted;
//   - every call is recorded like an MCP call, as playground.call, with the session id.
import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { buildContext, type Ctx } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { sameOrigin } from "./login";
import { shellFor } from "./shell";
import { callTool, toolDefinition, toolsFor } from "../mcp/tools";
import { takeRateDetail } from "../rate";
import { note } from "../log";

export const PLAYGROUND_HEADER = "x-pimwell-playground";
const SCOPE_SETS: Record<string, string[]> = { read: ["read"], write: ["read", "write"] };
const MAX_BODY = 64 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** Who may use the Playground: a signed-in person, in their browser session, on an organization they belong to. */
function allowed(ctx: Ctx): "ok" | "not_found" | "forbidden" {
  if (ctx.host.kind !== "tenant" || !ctx.tenant || ctx.tenant.state !== "active" || !ctx.identity || !ctx.role) return "not_found";
  if (ctx.identity.kind !== "human" || ctx.authKind !== "cookie" || ctx.session?.kind !== "browser") return "forbidden";
  return "ok";
}

export async function playgroundPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (allowed(ctx) !== "ok") return notFoundPage(extra);
  const set = new URL(request.url).searchParams.get("scopes") === "write" ? "write" : "read";
  const tools = toolsFor({ ...ctx, playground: { scopes: SCOPE_SETS[set]! } }).map(toolDefinition);
  const example = (schema: { properties?: Record<string, unknown>; required?: string[] }) =>
    JSON.stringify(Object.fromEntries((schema.required ?? []).map((k) => [k, ""])), null, 2);
  const cards = tools.map((t) => `<details class="card"><summary><strong>${esc(t.name)}</strong> <small>${esc((t.description ?? "").split("\n")[0]!)}</small></summary>
<form class="pg" data-tool="${esc(t.name)}"><label>Arguments (JSON)<br><textarea name="args" rows="4" cols="60" spellcheck="false">${esc(example(t.inputSchema as never))}</textarea></label><br><button type="submit">Run</button></form>
<details><summary><small>Input schema</small></summary><pre>${esc(JSON.stringify(t.inputSchema, null, 2))}</pre></details>
<div class="out" hidden></div></details>`).join("");
  const body = `<h1>MCP Playground</h1>
<p class="lede">Run any tool exactly as an assistant connected to ${esc(ctx.tenant!.display_name)} would: same tools, same checks, same answers. It acts as you, in this organization only, and every call is on the record.</p>
<div class="chips"><a class="chip" href="?scopes=read"${set === "read" ? ' aria-current="true"' : ""}>Read only</a><a class="chip" href="?scopes=write"${set === "write" ? ' aria-current="true"' : ""}>Read and write</a></div>
<p><small>${tools.length} tools with ${set === "read" ? "the read scope" : "the read and write scopes"} at your role (${esc(ctx.role!)}). Write tools change real data.</small></p>
${cards || `<p class="lede">No tools for this scope at your role.</p>`}
<script>
for (const f of document.querySelectorAll("form.pg")) f.addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = f.parentElement.querySelector(".out"); out.hidden = false; out.textContent = "Running...";
  let args; try { args = JSON.parse(f.args.value || "{}"); } catch { out.textContent = "Arguments are not valid JSON."; return; }
  const r = await fetch("/playground/call", { method: "POST", headers: { "content-type": "application/json", "${PLAYGROUND_HEADER}": "1" },
    body: JSON.stringify({ tool: f.dataset.tool, arguments: args, scopes: ${JSON.stringify(set)} }) });
  const j = await r.json().catch(() => ({ error: "unreadable response" }));
  out.replaceChildren();
  const add = (h, t) => { const d = document.createElement("div"); const b = document.createElement("h3"); b.textContent = h; const p = document.createElement("pre"); p.textContent = t; d.append(b, p); out.append(d); };
  if (!r.ok) { add("Refused (" + r.status + ")", JSON.stringify(j, null, 2)); return; }
  add("What the assistant reads (" + j.ms + " ms)", (j.response.result.content || []).map((c) => c.text).join("\\n"));
  add("Request", JSON.stringify(j.request, null, 2)); add("Response", JSON.stringify(j.response, null, 2));
});
</script>`;
  return htmlResponse(page("MCP Playground", body, shellFor(ctx, env, "playground")), 200, extra);
}

export async function playgroundCall(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const who = allowed(ctx);
  if (who === "not_found") return json({ error: "not_found" }, 404);
  if (who === "forbidden") return json({ error: "forbidden", reason: "the Playground runs only in your own browser session" }, 403);
  // Cross-site defence in two layers: the browser's Origin must be this host, and the custom header forces a CORS
  // preflight that no other site can pass.
  if (!sameOrigin(request) || request.headers.get(PLAYGROUND_HEADER) !== "1" || !(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return json({ error: "forbidden", reason: "same-origin JSON requests from the Playground only" }, 403);
  }
  const rate = await takeRateDetail(env.RATE, "playground_session", ctx.session!.id, ctx.now);
  if (!rate.ok) return json({ error: "too_many_requests" }, 429);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: "too_large" }, 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad_request", reason: "invalid JSON" }, 400); }
  const b = body as { tool?: unknown; arguments?: unknown; scopes?: unknown };
  if (typeof b.tool !== "string" || b.tool.length < 1 || b.tool.length > 64) return json({ error: "bad_request", reason: "tool must be a tool name" }, 400);
  const args = b.arguments ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) return json({ error: "bad_request", reason: "arguments must be an object" }, 400);
  const scopes = typeof b.scopes === "string" ? SCOPE_SETS[b.scopes] : undefined;
  if (!scopes) return json({ error: "bad_request", reason: "scopes must be read or write" }, 400);
  const started = Date.now();
  note(request, { verb: `tool:${String(b.tool).slice(0, 64)}`, via: "playground" });
  const result = await callTool({ ...ctx, playground: { scopes } }, b.tool, args as Record<string, unknown>);
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: b.tool, arguments: args } };
  return json({ request: call, response: { jsonrpc: "2.0", id: 1, result }, ms: Date.now() - started });
}
