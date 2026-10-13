import type { Env } from "../env";
import { shellFor } from "./shell";
import { esc, htmlResponse, inspectorSection, page, toolbar } from "../html";
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

  const setting = (a: Agent, isActive: boolean) => {
    const act = activity.get(a.identity.id) ?? {tokens:0,runs:0};
    return inspectorSection(a.identity.display_name, [
      {label:"Address",html:`<a href="/people/${esc(encodeURIComponent(a.identity.email))}">${esc(a.identity.email)}</a>`},
      {label:"Role",html:esc(a.membership.role)},{label:"Operator",html:opOf(a)},
      {label:"Sessions",html:`${act.tokens} tokens · ${act.runs} runs`},{label:"Created",html:when(a.identity.created_at)},
      ...(isActive ? [{label:"Access",html:"Active",editHtml:`<form method="post" action="/api/agent.archive"><input type="hidden" name="agent_id" value="${esc(a.identity.id)}"><input type="hidden" name="_back" value="/admin/agents"><button type="submit" class="quiet">Archive</button></form>`}] : [])
    ]);
  };
  const body = `<h1>${esc(tenant.display_name)} agents</h1>
${toolbar("Admin settings",'<a href="/people?connect=1">Connect an agent</a><a href="/people?invite=1">Invite a person</a><a href="/mail?addresses=1">Mail settings</a><a href="/mail/recipients">Response recipients</a>')}
<h2>Active agents</h2>${active.map(a=>setting(a,true)).join("") || '<p class="lede">None.</p>'}
<details><summary>Archived agents · ${archived.length}</summary>${archived.map(a=>setting(a,false)).join("") || '<p class="lede">None.</p>'}</details>`;
  return htmlResponse(page("Agents", body, shellFor(ctx, env, "admin")), 200, extra);
}
