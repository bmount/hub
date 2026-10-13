import { ASSETS } from "../assets";
import type { Env } from "../env";
import { buildContext, rank } from "../auth/context";
import { esc, htmlResponse, page } from "../html";
import { shellFor } from "./shell";
import { notFoundPage } from "./pages";
import { HubError } from "../errors";
import { contactProject, personRead, companyRead, personList, companyList, graphNeighbors } from "../verbs/contacts";

export async function contactPage(request: Request, env: Env, project: string, id: string | null): Promise<Response> {
  const ctx = await buildContext(request, env);
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.identity || !ctx.role) return notFoundPage();
  try {
    const p = await contactProject(ctx, project);
    const url = new URL(request.url), base = `/${esc(project)}/contacts`;
    let body = `<p><a href="/${esc(project)}">${esc(project)}</a> / <a href="${base}">People and companies</a></p>`;
    if (!id) {
      const kind = url.searchParams.get("kind") === "company" ? "company" : "person";
      const verb = kind === "person" ? personList : companyList;
      const v = await verb.run(ctx, verb.parse({project, q: url.searchParams.get("q"), tag: url.searchParams.get("tag"), after: url.searchParams.get("after")}));
      body += `<h1>People and companies</h1><p>Workspace contacts, not Pimwell accounts or memberships.</p><p><a href="${base}?kind=person">People</a> · <a href="${base}?kind=company">Companies</a></p><form method="get"><input type="hidden" name="kind" value="${kind}"><label>Name <input name="q" value="${esc(url.searchParams.get("q") ?? "")}"></label><label>Tag <input name="tag" value="${esc(url.searchParams.get("tag") ?? "")}"></label><button>Filter</button></form><ul>${v.entities.map(n => `<li><a href="${base}/${esc(String(n.id))}">${esc(String(n.name))}</a></li>`).join("")}</ul>${v.next_cursor ? `<a href="${base}?${esc(new URLSearchParams({kind, after: v.next_cursor, q: url.searchParams.get("q") ?? "", tag: url.searchParams.get("tag") ?? ""}).toString())}">Next contacts</a>` : ""}`;
      if (p.state === "active" && rank(ctx.role) >= rank("member")) body += `<h2>New ${kind}</h2><form method="post" action="/api/${kind}.upsert"><input type="hidden" name="project" value="${esc(project)}"><input type="hidden" name="_back" value="@result"><label>Name <input name="name" required maxlength="200"></label><label>Notes <textarea name="notes" rows="6"></textarea></label><button>Create contact</button></form><p>Use MCP to edit contact fields, merge people, add connections and link items, research, files or readable mail.</p>`;
    } else {
      const kind = await ctx.db.prepare("SELECT kind FROM contact_entity WHERE tenant_id = ? AND project_id = ? AND id = ?").bind(ctx.tenant.id, p.id, id).first<{kind: string}>();
      if (!kind) return notFoundPage();
      const verb = kind.kind === "person" ? personRead : companyRead;
      const v = await verb.run(ctx, verb.parse({project, id}));
      const hops = Math.max(1, Math.min(6, Number(url.searchParams.get("hops")) || 1));
      const g = await graphNeighbors.run(ctx, graphNeighbors.parse({project, id, hops}));
      body += `<h1>${esc(String(v.entity.name))}</h1><p>${esc(kind.kind)} · revision ${String(v.entity.revision)}</p><dl>${Object.entries(v.entity).filter(([k]) => !["id", "kind", "name", "revision", "updated_at"].includes(k)).map(([k, x]) => `<dt>${esc(k)}</dt><dd style="white-space:pre-wrap">${esc(Array.isArray(x) ? x.join(", ") : String(x))}</dd>`).join("")}</dl><h2>Backlinks</h2><ul>${v.backlinks.map(l => `<li>${esc(l.kind)}: <a href="${esc(l.href)}">${esc(l.title)}</a></li>`).join("")}</ul><h2>Connection graph</h2><form method="get"><label>Hops <input type="number" name="hops" min="1" max="6" value="${hops}"></label><button>Show neighborhood</button></form><p>Drag nodes to rearrange. Use +/− to zoom; click a name to open that contact.</p><div data-contact-graph><button type="button" data-graph-zoom="0.8" aria-label="Zoom in">+</button><button type="button" data-graph-zoom="1.25" aria-label="Zoom out">−</button><svg viewBox="0 0 900 600" role="img" aria-label="Contact neighborhood" style="width:100%;height:600px;touch-action:none;border:1px solid currentColor">`;
      const points = new Map(g.nodes.map((n, i) => [n.id, n.id === id ? {x: 450, y: 300} : {x: 450 + Math.cos(i * 2 * Math.PI / g.nodes.length) * 260, y: 300 + Math.sin(i * 2 * Math.PI / g.nodes.length) * 220}]));
      body += g.connections.map(c => {const a = points.get(c.a)!, b = points.get(c.b)!; return `<line data-a="${esc(c.a)}" data-b="${esc(c.b)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="currentColor"><title>${esc(c.type)}</title></line>`;}).join("");
      body += g.nodes.map(n => {const pos = points.get(n.id)!; return `<g data-node="${esc(n.id)}" transform="translate(${pos.x} ${pos.y})"><circle r="${n.id === id ? 16 : 12}" fill="${n.kind === "person" ? "#4279ad" : "#8b609b"}" stroke="currentColor"/><a href="${base}/${esc(n.id)}"><text y="30" text-anchor="middle" fill="currentColor">${esc(n.name)}</text></a><title>${esc(n.kind)} · ${n.depth} hops</title></g>`;}).join("");
      body += `</svg></div><script src="${ASSETS.graph.path}" defer></script><h2>Connections</h2><ul>${g.connections.map(c => `<li><a href="${base}/${esc(c.a)}">${esc(g.nodes.find(n => n.id === c.a)!.name)}</a> ↔ <a href="${base}/${esc(c.b)}">${esc(g.nodes.find(n => n.id === c.b)!.name)}</a> · ${esc(c.type)} · ${c.strength ?? "unrated"} · ${esc(c.date)} · ${esc(c.source)}</li>`).join("")}</ul>`;
    }
    return htmlResponse(page("People and companies", body, shellFor(ctx, env, "project", project)));
  } catch (e) {if (e instanceof HubError && [400, 404].includes(e.status)) return notFoundPage(); throw e;}
}
