// The signed-in shell: who you are, which organization, and every section one click away.
import type { Env } from "../env";
import type { Ctx } from "../auth/context";
import { rank } from "../auth/context";
import { esc, kitTree, type Shell, type KitLink, type TreeNode } from "../html";
import { projectFeatures } from "../projectFeatures";

export type Section = "home" | "situations" | "reviews" | "apps" | "usage" | "attention" | "docket" | "mine" | "mail" | "chat" | "people" | "admin" | "account" | "hub" | "project" | "playground" | "planned" | "new";

// Short reminders that the old way is not required any more. One per page, chosen by page, so it rotates.
export const TIPS = [
  "No triage meeting needed. File it here, or forward the thread to the project's address.",
  "You don't need to know which team owns something. Send it to the project and Pimwell sorts it.",
  "Status comes from the record, so nobody has to write a status report.",
  "Agents can pick work up the moment it's filed. No waiting for the next standup.",
  "Everything here also works from Claude or ChatGPT, over MCP.",
  "Nothing finished is thrown away. Archived work still answers questions.",
  "A decision made in a thread can be filed as a call, with its source, in one step.",
  "You don't have to look things up for an agent. Each job arrives with what Pimwell already knows.",
];

function tipFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TIPS[h % TIPS.length]!;
}

export function shellFor(ctx: Ctx, env: Env, active: Section, key: string = active): Shell | undefined {
  if (!ctx.identity) return undefined;
  const hub = `https://${env.HUB_DOMAIN}/`;
  const me = { name: ctx.identity.display_name, email: ctx.identity.email, role: ctx.role, href: `${hub}me` };
  if (ctx.host.kind === "tenant" && ctx.tenant && ctx.role) {
    const r = ctx.rail;
    const link = (href: string, label: string, section: Section | null, count?: number) => ({ href, label, active: section === active, ...(count !== undefined ? { count } : {}) });
    const nav = [
      link("/", "Home", "home"),
      link("/attention", "Needs me", "attention", r?.needs),
      link("/docket", "Docket", "docket", r?.open),
      link("/docket?owner=me", "Mine", "mine", r?.mine),
      link("/mail", "Mail", "mail", r?.held),
      link("/c", "Chat", "chat"),
      link("/people", "People and agents", "people"),
      link("/assistant", "Assistant", "playground"),
      link("/reviews", "Reviews", "reviews"),
      link("/situations", "Situations", "situations"),
      link("/apps", "Apps", "apps"),
      link("/usage", "AI usage", "usage"),
      ...(rank(ctx.role) >= rank("admin") ? [link("/admin/agents", "Admin", "admin")] : []),
    ];
    const planned = PLANNED_LINKS.map((l) => ({ href: l.href, label: l.label, active: active === "planned" && key === l.key, planned: true }));
    const tabs = [
      { href: "/docket", label: "Docket", active: active === "docket" || active === "project", count: r?.open },
      { href: "/c", label: "Chat", active: active === "chat" },
      { href: "/attention", label: "Needs me", active: active === "attention", count: r?.needs },
      { href: "/mail", label: "Mail", active: active === "mail", count: r?.held },
      { href: "/assistant", label: "Assistant", active: active === "playground" },
    ];
    return {
      brandHref: hub, org: { name: ctx.tenant.display_name, href: "/" }, me, tip: tipFor(key), nav, planned, tabs,
      breadcrumb: locationLinks(ctx, nav), explorer: projectExplorer(ctx, env),
      projectPath: ctx.explorer?.path, inProject: ctx.explorer?.inProject, preferenceKey: ctx.identity.id,
      canFile: rank(ctx.role) >= rank("member"),
    };
  }
  const nav = [
    { href: "/", label: "Your organizations", section: "home" },
    { href: "/me", label: "Account", section: "account" },
    { href: "/me/sessions", label: "Sessions", section: "hub" },
    ...(ctx.identity.is_root === 1 ? [{ href: "/admin/orgs", label: "Hub admin", section: "admin" }, { href: "/admin/apps", label: "Apps to approve", section: "apps" }] : []),
  ];
  return { brandHref: hub, org: null, me, tip: tipFor(key), breadcrumb: [{label: "Pimwell", href: "/"}, {label: key === "sessions" ? "Sessions" : nav.find(n => n.section === active)?.label ?? active, href: new URL(ctx.pageUrl ?? hub).pathname, current: true}], nav: nav.map((n) => ({ href: n.href, label: n.label, active: n.section === active })) };
}

const VIEW_LABELS: Record<string, string> = { docket: "Docket", graph: "Dependency graph", frontier: "Execution frontier", w: "Docket", board: "Board", status: "Status", code: "Repository and code", files: "Code files", reviews: "Reviews", wiki: "Wiki", documents: "Files", contacts: "Contacts and graph", c: "Chat", mail: "Mail", attention: "Needs me", people: "People and agents", assistant: "Assistant", apps: "Apps", usage: "AI usage", admin: "Admin", search: "Search", new: "File work", archive: "Archive", planned: "Coming" };

function locationLinks(ctx: Ctx, nav: Shell["nav"]): KitLink[] {
  const url = new URL(ctx.pageUrl ?? "https://pimwell.com/"), segments = url.pathname.split("/").filter(Boolean);
  const links: KitLink[] = [{ label: ctx.tenant!.display_name, href: "/" }];
  const p = ctx.explorer;
  let view: string | undefined;
  if (p?.inProject) {
    const base = `/${encodeURIComponent(p.path)}`;
    links.push({label: p.display_name, href: base});
    view = segments[1];
    if (view) links.push({label: view === "wiki" && url.searchParams.get("view") === "research" ? "Research" : view === "contacts" && url.searchParams.get("view") === "graph" ? "Contact graph" : VIEW_LABELS[view] ?? view, href: `${base}/${view === "w" ? "docket" : view}${url.searchParams.has("view") ? `?view=${encodeURIComponent(url.searchParams.get("view")!)}` : ""}`});
    if (segments.length > 2) links.push({label: (view === "w" ? "#" : "") + decodeURIComponent(segments.slice(2).join("/")), href: url.pathname + url.search});
  } else if (segments[0] === "apps" && url.searchParams.has("project")) {
    const project = url.searchParams.get("project")!;
    links.push({label: ctx.explorer?.path === project ? ctx.explorer.display_name : project, href:`/${encodeURIComponent(project)}`});
    links.push({label:"Deploys",href:`/apps?project=${encodeURIComponent(project)}#deploys`});
  } else {
    view = segments[0];
    const label = view ? VIEW_LABELS[view] ?? nav.find(n => n.active)?.label ?? view : "Home";
    if (p && ["attention", "mail", "c", "assistant"].includes(view ?? "")) links.push({label:p.display_name,href:`/${encodeURIComponent(p.path)}`});
    links.push({label, href: view ? `/${view}` : "/"});
    if (view === "c" && segments[1]) {
      links.push({label:`#${decodeURIComponent(segments[1])}`,href:`/c/${segments[1]}`});
      if (segments[2] === "t" && segments[3]) links.push({label:`Thread #${segments[3]}`,href:url.pathname + url.search});
    } else if (segments.length > 1) links.push({label: decodeURIComponent(segments.slice(1).join("/")), href: url.pathname + url.search});
  }
  const selected = ["work", "f", "c", "path", "g", "d", "thread", "t"].map(k => url.searchParams.get(k)).find(Boolean);
  if (selected) links.push({label: selected, href: url.pathname + url.search});
  links[links.length - 1]!.current = true;
  return links;
}

function projectExplorer(ctx: Ctx, env: Env): string {
  const p = ctx.explorer;
  if (!p) return `<h2>Projects</h2><p>No active projects.</p><a href="/projects/new">New project</a>`;
  const base = `/${encodeURIComponent(p.path)}`, features = projectFeatures(p.kind), nodes: TreeNode[] = [];
  const url = new URL(ctx.pageUrl ?? "https://pimwell.com/"), pathname = url.pathname;
  const node = (label: string, href: string, count?: number): TreeNode => ({label, href, count, current: pathname === href.split("#")[0] && (!href.includes("#") || url.hash === href.slice(href.indexOf("#")))});
  if (features.includes("docket")) nodes.push({...node("Docket", `${base}/docket`, p.open), expanded: true, children: [node("Graph", `${base}/graph`), node("Frontier", `${base}/frontier`), node("Board", `${base}/board`, p.open), node("Status", `${base}/status`, p.open)]});
  if (features.includes("repo")) nodes.push({...node("Repository and code", `${base}/code`), expanded: true, children: [node("Code files", `${base}/files`), node("Reviews", `${base}/reviews`, p.reviews), node("Deploys", `/apps?project=${encodeURIComponent(p.path)}#deploys`, p.deploys)]});
  if (features.includes("wiki")) nodes.push(node("Wiki", `${base}/wiki`, p.wiki));
  if (features.includes("knowledge")) nodes.push({...node("Knowledge base and research", `${base}/wiki`, p.wiki), expanded: true, children: [node("Knowledge base", `${base}/wiki`, p.wiki - p.research), node("Research", `${base}/wiki?view=research`, p.research)]});
  if (features.includes("files")) nodes.push(node("Files", `${base}/documents`, p.files));
  if (features.includes("people")) nodes.push(node("Contacts and graph", `${base}/contacts`, p.contacts));
  nodes.push({...node("Channels", "/c", p.channels.length), expanded: true, children: p.channels.map(c => node(c.display_name, `/c/${encodeURIComponent(c.slug)}`, c.count))});
  const address = `${ctx.tenant!.slug}.${p.path.replace("/", ".")}@${env.HUB_DOMAIN}`;
  const endpoint = `https://${ctx.tenant!.slug}.${env.HUB_DOMAIN}/p/${p.path}/mcp`;
  nodes.push(node("Mail", `/mail?project=${encodeURIComponent(p.path)}`, p.mail));
  return `<nav class="project-switcher" aria-label="Project switcher"><a class="project-heading" href="${esc(base)}">${esc(p.display_name)}</a></nav>${kitTree("Project resources", nodes)}
    <section class="project-endpoints"><div><a id="explorer-mail" href="mailto:${esc(address)}" title="${esc(address)}">${esc(address)}</a><button type="button" class="quiet" data-copy="#explorer-mail" aria-label="Copy mail address">⧉</button></div><div><code id="explorer-mcp" title="${esc(endpoint)}">${esc(endpoint)}</code><button type="button" class="quiet" data-copy="#explorer-mcp" aria-label="Copy MCP endpoint">⧉</button></div></section>
    <input id="project-filter" type="search" placeholder="Find a project…" aria-label="Find a project" autocomplete="off"><nav class="project-switcher" aria-label="Other projects"><ul>${p.choices.filter(c => c.path !== p.path).map(c => `<li><a href="/${esc(encodeURIComponent(c.path))}"><span aria-hidden="true">›</span> ${esc(c.display_name)}</a></li>`).join("")}</ul></nav>`;
}

/** Areas still being built, kept in plain view (src/verbs/planned.ts). */
export const PLANNED_LINKS = [
  { href: "/planned", label: "Everything coming", key: "all" },
];
