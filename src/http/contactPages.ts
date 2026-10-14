import { ASSETS } from "../assets";
import type { Env } from "../env";
import { buildContext, rank } from "../auth/context";
import { esc, htmlResponse, workbench, kitTable, kitTabs, toolbar, inspectorSection } from "../html";
import { shellFor } from "./shell";
import { notFoundPage } from "./pages";
import { HubError } from "../errors";
import { contactProject, personRead, companyRead, personList, companyList, graphNeighbors } from "../verbs/contacts";

export async function contactPage(request: Request, env: Env, project: string, id: string | null): Promise<Response> {
  const ctx = await buildContext(request, env);
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.identity || !ctx.role) return notFoundPage();
  try {
    const p = await contactProject(ctx, project);
    const url = new URL(request.url), base = `/${project}/contacts`;
    const query = new URLSearchParams(url.searchParams); query.delete("new");
    const target = (entity: string | null, changes: Record<string,string | null> = {}) => {
      const q = new URLSearchParams(query);
      for (const [k,v] of Object.entries(changes)) {if (v === null) q.delete(k); else q.set(k,v);}
      return `${base}${entity ? `/${entity}` : ""}${q.size ? `?${q}` : ""}`;
    };
    const kind = query.get("kind") === "company" ? "company" : "person";
    const shell = shellFor(ctx,env,"project",project)!;
    const writable = p.state === "active" && rank(ctx.role) >= rank("member");
    const verb = kind === "person" ? personList : companyList;
    const contacts = await verb.run(ctx, verb.parse({project,q:query.get("q"),tag:query.get("tag"),after:query.get("after")}));
    let list = `<h1>People and companies</h1>` + toolbar("Contact actions", kitTabs("Contact kinds",[{label:"People",href:target(null,{kind:"person",after:null}),current:kind === "person"},{label:"Companies",href:target(null,{kind:"company",after:null}),current:kind === "company"}]) + (writable ? `<a href="${esc(target(null,{new:"1"}))}">Add contact</a>` : ""), `<form method="get" action="${esc(base)}"><input type="hidden" name="kind" value="${kind}"><label>Name <input name="q" value="${esc(query.get("q") ?? "")}"></label><label>Tag <input name="tag" value="${esc(query.get("tag") ?? "")}"></label><noscript><button>Apply filters</button></noscript></form>`) + kitTable("Contacts",[{label:"Name"},{label:"Kind"}],contacts.entities.map(n=>({href:target(String(n.id)),selected:n.id === id,cells:[{html:`<a href="${esc(target(String(n.id)))}">${esc(String(n.name))}</a>`},{html:esc(String(n.kind))}]})));
    if (contacts.next_cursor) list += `<a href="${esc(target(null,{after:contacts.next_cursor}))}">Next contacts</a>`;
    let body = `<a class="back" href="${esc(target(null,{view:null,hops:null}))}">Close</a>`;
    if (!id && writable && url.searchParams.has("new")) body += `<h2>New ${kind}</h2><form method="post" action="/api/${kind}.upsert"><input type="hidden" name="project" value="${esc(project)}"><input type="hidden" name="_back" value="@result"><label>Name <input name="name" required maxlength="200"></label><label>Notes <textarea name="notes" rows="6"></textarea></label><button>Create contact</button></form>`;
    if (id) {
      const k = await ctx.db.prepare("/*perf-site:src%2Fhttp%2FcontactPages.ts:32:23:k*/ SELECT kind FROM contact_entity WHERE tenant_id = ? AND project_id = ? AND id = ?").bind(ctx.tenant.id,p.id,id).first<{kind:string}>();
      if (!k) return notFoundPage();
      const read = k.kind === "person" ? personRead : companyRead;
      const v = await read.run(ctx,read.parse({project,id}));
      const hops = Math.max(1,Math.min(6,Number(query.get("hops")) || 1));
      const g = await graphNeighbors.run(ctx,graphNeighbors.parse({project,id,hops}));
      if (shell.breadcrumb?.length) shell.breadcrumb[shell.breadcrumb.length-1]!.label = String(v.entity.name);
      body += `<h1>${esc(String(v.entity.name))}</h1>` + inspectorSection("Contact",[{label:"Kind",html:esc(k.kind)},...Object.entries(v.entity).filter(([key,value])=>!["id","kind","name","revision","updated_at"].includes(key) && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0)).map(([label,value])=>({label:label.replaceAll("_"," ").replace(/^./,c=>c.toUpperCase()),html:esc(Array.isArray(value) ? value.join(", ") : String(value))}))]);
      body += kitTable("Backlinks",[{label:"Kind"},{label:"Record"}],v.backlinks.map(l=>({cells:[{html:esc(l.kind)},{html:`<a href="${esc(l.href)}">${esc(l.title)}</a>`}]})));
      body += kitTable("Connections",[{label:"Contact"},{label:"Type"},{label:"Strength"}],g.connections.filter(c=>c.a === id || c.b === id).map(c=>{const other = c.a === id ? c.b : c.a; const n = g.nodes.find(n=>n.id === other)!; return {href:target(other,{kind:n.kind}),cells:[{html:`<a href="${esc(target(other,{kind:n.kind}))}">${esc(n.name)}</a>`},{html:`${esc(c.type)}<div class="wb-hint">${esc(c.date)} · ${esc(c.source)}</div>`},{html:esc(String(c.strength ?? "unrated"))}]};}));
      const views = kitTabs("Contact views",[{label:"Table",href:target(id,{view:null}),current:query.get("view") !== "graph"},{label:"Graph",href:target(id,{view:"graph"}),current:query.get("view") === "graph"}]);
      if (query.get("view") === "graph") {
        list = `<h1>${esc(String(v.entity.name))} · neighborhood</h1>` + toolbar("Graph actions",views,`<form method="get"><input type="hidden" name="view" value="graph"><input type="hidden" name="kind" value="${kind}"><label>Hops <input type="number" name="hops" min="1" max="6" value="${hops}"></label><noscript><button>Apply filters</button></noscript></form>`);
        list += `<div data-contact-graph><button type="button" class="quiet" data-graph-zoom="0.8" aria-label="Zoom in">+</button><button type="button" class="quiet" data-graph-zoom="1.25" aria-label="Zoom out">−</button><svg viewBox="0 0 900 600" role="img" aria-label="Contact neighborhood" style="width:100%;height:auto;touch-action:none">`;
        const points = new Map(g.nodes.map((n,i)=>[n.id,n.id === id ? {x:450,y:300} : {x:450+Math.cos(i*2*Math.PI/g.nodes.length)*260,y:300+Math.sin(i*2*Math.PI/g.nodes.length)*220}]));
        list += g.connections.map(c=>{const a=points.get(c.a)!,b=points.get(c.b)!; return `<line data-a="${esc(c.a)}" data-b="${esc(c.b)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="currentColor"><title>${esc(c.type)}</title></line>`;}).join("");
        list += g.nodes.map(n=>{const pos=points.get(n.id)!; return `<g data-node="${esc(n.id)}" transform="translate(${pos.x} ${pos.y})"><circle r="${n.id === id ? 16 : 12}" fill="var(--accent)" stroke="currentColor"/><a href="${esc(target(n.id,{kind:n.kind,view:"graph"}))}"><text y="30" text-anchor="middle" fill="currentColor">${esc(n.name)}</text></a><title>${esc(n.kind)} · ${n.depth} hops</title></g>`;}).join("");
        list += `</svg></div><script src="${ASSETS.graph.path}" defer></script>`;
      } else list = views + list;
    }
    return htmlResponse(workbench("People and companies",{list,stackOnPhone:true,listKey:`contacts:${project}:${query.get("view") === "graph" ? id : ""}:${query}`,inspector:id || url.searchParams.has("new") ? body : "",inspectorKey:id ? `contact:${id}` : "",focus:url.searchParams.has("new") ? "inspector" : undefined},shell));
  } catch (e) {if (e instanceof HubError && [400,404].includes(e.status)) return notFoundPage(); throw e;}
}
