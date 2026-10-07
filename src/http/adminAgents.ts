import type { Env } from "../env";
import { shellFor } from "./shell";
import { esc, htmlResponse, page } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { listAgentsForTenant, tenantAgentActivity } from "../db/agents";
import { getIdentityById } from "../db/identities";
import { notFoundPage } from "./pages";
import type { Agent } from "../db/types";

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export async function adminAgentsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.identity || ctx.identity.kind !== "human" || rank(ctx.role) < rank("admin")) return notFoundPage(extra);
  const tenant = ctx.tenant;
  const [active, archived, activity] = await Promise.all([
    listAgentsForTenant(ctx.db, tenant.id, "active"),
    listAgentsForTenant(ctx.db, tenant.id, "archived"),
    tenantAgentActivity(ctx.db, tenant.id, ctx.now),
  ]);
  const operatorIds = [...new Set([...active, ...archived].map((a) => a.identity.operator_id).filter((x): x is string => x !== null))];
  const operators = new Map<string, string>();
  for (const id of operatorIds) {
    const op = await getIdentityById(ctx.db, id);
    if (op) operators.set(id, op.email);
  }
  const opOf = (a: Agent) => esc(a.identity.operator_id ? operators.get(a.identity.operator_id) ?? "unknown" : "none");

  const activeRows = active.map((a) => {
    const act = activity.get(a.identity.id) ?? { tokens: 0, runs: 0 };
    return `<tr><td><code>${esc(a.identity.email)}</code></td><td>${esc(a.identity.display_name)}</td><td>${esc(a.membership.role)}</td><td>${opOf(a)}</td>`
      + `<td>${act.tokens}</td><td>${act.runs}</td><td>${when(a.identity.created_at)}</td>`
      + `<td><form class="inline" method="post" action="/api/agent.archive"><input type="hidden" name="agent_id" value="${esc(a.identity.id)}">`
      + `<input type="hidden" name="_back" value="/admin/agents"><button type="submit">Archive</button></form></td></tr>`;
  }).join("");
  const archivedRows = archived.map((a) =>
    `<tr><td><code>${esc(a.identity.email)}</code></td><td>${esc(a.identity.display_name)}</td><td>${opOf(a)}</td><td>${when(a.identity.created_at)}</td></tr>`).join("");

  const body = `<h1>${esc(tenant.display_name)} agents</h1><p><a href="/">back</a></p>`
    + (active.length
      ? `<table><thead><tr><th>Address</th><th>Name</th><th>Role</th><th>Operator</th><th>Tokens</th><th>Runs</th><th>Created</th><th></th></tr></thead><tbody>${activeRows}</tbody></table>`
      : "<p>None.</p>")
    + `<h2>Archived</h2>`
    + (archived.length
      ? `<table><thead><tr><th>Address</th><th>Name</th><th>Operator</th><th>Created</th></tr></thead><tbody>${archivedRows}</tbody></table>`
      : "<p>None.</p>");
  return htmlResponse(page("Helpers", body, shellFor(ctx, env, "admin")), 200, extra);
}
