import { span } from "./perf";
import { ASSETS } from "./assets";

const MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => MAP[ch]!);
}

/** Kit slots named `html` contain trusted, already-escaped server markup; labels are plain text. */
export type KitLink = { label: string; href: string; current?: boolean; count?: number; selection?: boolean };
const kitHref = (href: string) => esc(/^(\/(?!\/)|https?:\/\/|mailto:|#)/i.test(href) ? href : "#");
const kitLink = (l: KitLink) => `<a href="${kitHref(l.href)}"${l.current ? ' aria-current="page"' : ""}>${esc(l.label)}${l.count !== undefined && l.count > 0 ? `<span class="wb-count">${esc(String(l.count))}</span>` : ""}</a>`;

export function timeText(ms: number, now: number, timeZone?: string): string {
  const d = new Date(ms), today = new Date(now);
  const todayKey = today.toLocaleDateString("en-GB", {timeZone}).split("/").reverse().join("-");
  const dateKey = d.toLocaleDateString("en-GB", {timeZone}).split("/").reverse().join("-");
  const days = Math.round((Date.parse(todayKey) - Date.parse(dateKey)) / 86400000);
  if (days === 0) return "Today " + d.toLocaleTimeString("en-GB", {hour:"2-digit", minute:"2-digit", hour12:false, timeZone});
  if (days > 0 && days < 7) return d.toLocaleDateString("en-GB", {weekday:"short", timeZone}) + " " + d.toLocaleTimeString("en-GB", {hour:"2-digit", minute:"2-digit", hour12:false, timeZone});
  return d.toLocaleDateString("en-GB", {day:"numeric", month:"short", ...(d.getUTCFullYear() !== today.getUTCFullYear() ? {year:"numeric" as const} : {}), timeZone});
}

export function localTime(ms: number | null): string {
  if (ms === null) return "Not recorded";
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "Not recorded";
  return `<time datetime="${date.toISOString()}" data-local-time="${ms}" title="${esc(date.toUTCString())}">${esc(timeText(ms, Date.now(), "UTC"))} UTC</time>`;
}

export const naturalName = (a: string, b: string) => a.localeCompare(b, undefined, {numeric:true, sensitivity:"base"});
export const plural = (n: number, singular: string, multiple = singular + "s") => `${n} ${n === 1 ? singular : multiple}`;

export function address(email: string, href?: string): string {
  return `<span class="wb-address">${href ? `<a href="${kitHref(href)}">` : ""}<code>${esc(email)}</code>${href ? "</a>" : ""}<button type="button" class="quiet" data-copy="address" aria-label="Copy ${esc(email)}">⧉</button></span>`;
}

export function breadcrumb(links: KitLink[]): string {
  return `<nav class="wb-breadcrumb" aria-label="Breadcrumb"><ol>${links.map(l => `<li>${kitLink(l)}</li>`).join("")}</ol></nav>`;
}

/** URL navigation, not ARIA tabs: native links support reload, history and no-JS use. */
export function kitTabs(label: string, links: KitLink[]): string {
  return `<nav class="wb-tabs" aria-label="${esc(label)}">${links.map(kitLink).join("")}</nav>`;
}

export function toolbar(label: string, actionsHtml: string, filtersHtml = ""): string {
  return `<div class="wb-toolbar" role="group" aria-label="${esc(label)}"><div class="wb-actions">${actionsHtml}</div>${filtersHtml ? `<div class="wb-filters">${filtersHtml}</div>` : ""}</div>`;
}

export type KitCell = { html: string; className?: string };
export type KitRow = { cells: KitCell[]; href?: string; selected?: boolean };
/** Keep a real anchor in a cell: data-href supplements native keyboard/no-JS navigation. */
export function kitTable(label: string, headings: { label: string; className?: string }[], rows: KitRow[]): string {
  return `<div class="wb-table-wrap"><table class="wb-table" aria-label="${esc(label)}"><thead><tr>${headings.map(h => `<th scope="col"${h.className ? ` class="${esc(h.className)}"` : ""}>${esc(h.label)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr${r.href ? ` data-href="${kitHref(r.href)}" aria-selected="${r.selected ? "true" : "false"}"` : ""}>${r.cells.map(c => `<td${c.className ? ` class="${esc(c.className)}"` : ""}>${c.html}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function kitList(label: string, rows: { html: string; href?: string; selected?: boolean }[]): string {
  return kitTable(label, [{label}], rows.map(r => ({href: r.href, selected: r.selected, cells: [{html: r.html}]})));
}

export type TreeNode = KitLink & { children?: TreeNode[]; expanded?: boolean; afterHtml?: string };
/** Native details keeps the row link distinct from its expansion chevron. */
export function kitTree(label: string, nodes: TreeNode[]): string {
  const branch = (items: TreeNode[]): string => `<ul>${items.map(n => `<li>${n.children ? `<details${n.expanded ? " open" : ""}><summary><span class="wb-chevron" aria-hidden="true">›</span>${kitLink(n)}</summary>${n.afterHtml ?? ""}${branch(n.children)}</details>` : kitLink(n)}</li>`).join("")}</ul>`;
  return `<nav class="wb-tree" aria-label="${esc(label)}">${branch(nodes)}</nav>`;
}

export type ChipTone = "open" | "doing" | "done" | "dropped" | "blocked" | "wish" | "snag" | "errand" | "quest" | "call" | "spark";
export function statusChip(label: string, tone: ChipTone): string {
  return `<span class="wb-chip${["open","doing","done","dropped","blocked"].includes(tone) ? " wb-state" : ""} wb-tone-${esc(tone)}">${esc(label)}</span>`;
}

export function inspectorSection(heading: string, rows: { label: string; html: string; editHtml?: string }[], actionsHtml = ""): string {
  return `<section class="wb-section"><h2>${esc(heading)}</h2><dl>${rows.map(r => `<dt>${esc(r.label)}</dt><dd>${r.editHtml ? `<details class="wb-inline-edit"><summary aria-label="Change ${esc(r.label)}">${r.html}<span class="wb-pencil" aria-hidden="true">✎</span></summary>${r.editHtml}</details>` : r.html}</dd>`).join("")}</dl>${actionsHtml}</section>`;
}

export function formRow(id: string, label: string, controlHtml: string, hint = ""): string {
  return `<div class="wb-form-row"><label for="${esc(id)}">${esc(label)}</label><div>${controlHtml}${hint ? `<p class="wb-hint" id="${esc(id)}-hint">${esc(hint)}</p>` : ""}</div></div>`;
}

export function emptyState(heading: string, description: string, action: KitLink): string {
  return `<section class="wb-empty"><h2>${esc(heading)}</h2><p>${esc(description)}</p>${kitLink(action)}</section>`;
}

export type RailLink = { href: string; label: string; active: boolean; count?: number | null; planned?: boolean };

/**
 * The signed-in frame: one sidebar, a top bar with jump and file, and panes. `nav` is the sidebar's
 * sections; `projects` and `planned` are its lower groups; `tabs` is the phone's bottom bar.
 */
export type Shell = {
  brandHref: string; org: { name: string; href: string } | null; nav: RailLink[]; me: { name: string; email: string; role: string | null; href: string }; tip: string;
  projects?: RailLink[]; planned?: RailLink[]; tabs?: RailLink[]; canFile?: boolean; searchQuery?: string;
  breadcrumb?: KitLink[]; explorer?: string; projectPath?: string; inProject?: boolean; preferenceKey?: string;
};

/** Two panes: a list and an inspector. Keys tell the script which pane changed, so the other keeps its place. */
export type Panes = { list: string; listKey: string; inspector: string | null; inspectorKey?: string; stackOnPhone?: boolean; focus?: "list" | "inspector" };



const head = (title: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${ASSETS.css.path}">
</head>`;

const railLink = (l: RailLink) =>
  `<li><a href="${esc(l.href)}"${l.active ? ' aria-current="page"' : ""}>${esc(l.label)}</a>${l.planned ? '<span class="pill">planned</span>' : ""}${typeof l.count === "number" ? `<span class="n">${l.count}</span>` : ""}</li>`;

/** Log out: a real POST to this host, then a page that does not need a session. */
export const logout = (back: string) => `<form class="inline" method="post" action="/api/session.end" data-reload><input type="hidden" name="_back" value="${esc(back)}"><button type="submit" class="link">Sign out</button></form>`;

function frame(title: string, main: string, shell: Shell, focus: "list" | "inspector"): string {
  const org = shell.org !== null;
  const rail = `<aside id="rail" class="rail"><div class="railhead"><b>${esc(org ? shell.org!.name : "Pimwell")}</b><a class="close" href="#" aria-label="Close menu">✕ Close</a></div><div id="org-places">${kitTree("Primary", shell.nav.map(l => ({href: l.href, label: l.label, current: l.active, count: l.count ?? undefined})))}</div><!--PROJECT-TREE-->
${shell.projects?.length ? `<h4>Projects</h4><ul>${shell.projects.map(railLink).join("")}</ul>` : ""}
${shell.planned?.length ? `<h4>Coming</h4><ul>${shell.planned.map(railLink).join("")}</ul>` : ""}
</aside>`;
  const explorer = `<aside id="explorer" class="explorer" aria-label="Project explorer" data-project="${esc(shell.projectPath ?? "")}" data-in-project="${shell.inProject ? "1" : "0"}" data-preference="${esc(shell.preferenceKey ?? "")}"><div class="railhead"><b>Project explorer</b><a class="close" href="#" aria-label="Close project explorer">✕ Close</a></div>${shell.explorer ?? '<p>Open an organization to explore its projects.</p>'}</aside>`;
  const bar = `<header class="bar"><a class="menu" href="#rail" aria-label="Menu"><span aria-hidden="true">☰</span><span class="ml">Menu</span></a><button type="button" class="quiet sidebar-toggle" data-toggle-sidebar aria-label="Collapse sidebar" aria-expanded="true">☰</button>${breadcrumb(shell.breadcrumb ?? [{label: shell.org?.name ?? "Pimwell", href: shell.org?.href ?? shell.brandHref}, {label: title, href: "#", current: true}])}
${org ? `<form class="jump" data-perf="search" action="/search" method="get" role="search"><input data-perf="search" name="q" value="${esc(shell.searchQuery ?? "")}" placeholder="Search all projects…" maxlength="200" autocomplete="off" aria-label="Search all projects"><kbd>⌘K</kbd></form>` : `<span class="jump"></span>`}
${org && shell.canFile && !shell.breadcrumb?.some(c => c.label === "File work") ? `<a class="button quiet file" href="/new" title="File work (c)">+ File</a>` : ""}<a class="me" href="${esc(shell.me.href)}"><code id="header-email">${esc(shell.me.email)}</code>${shell.me.role ? ` (${esc(shell.me.role)})` : ""}</a><button type="button" class="quiet header-copy" data-copy="#header-email" aria-label="Copy your address">⧉</button>${logout(org ? "/signed-out" : "/")}</header>`;
  const tabs = shell.tabs?.length ? `<nav class="tabs" aria-label="Sections">${shell.tabs.map((t) => `<a href="${esc(t.href)}"${t.active ? ' aria-current="page"' : ""}>${esc(t.label)}${typeof t.count === "number" && t.count > 0 ? `<span class="n">${t.count}</span>` : ""}</a>`).join("")}<a href="#rail">More</a></nav>` : "";
  const status = `<footer class="status"><span id="perf"></span><span id="connection-state" role="status"></span><span class="keys hide-s">${org ? `<kbd>⌘K</kbd> search · <kbd>j</kbd>/<kbd>k</kbd> move${shell.canFile ? ' · <kbd>c</kbd> file' : ''} · <kbd>/</kbd> filter` : ""}</span><a href="${esc(shell.brandHref)}privacy">Privacy</a><a href="${esc(shell.brandHref)}terms">Terms</a></footer>`;
  return `${head(title)}
<body class="wb" data-focus="${focus}">
<script defer src="${ASSETS.timing.path}"></script>
${bar}
${rail.replace("<!--PROJECT-TREE-->", explorer)}
<a class="scrim" href="#" aria-hidden="true" tabindex="-1"></a>
${main}
${status}
${tabs}
<script src="${ASSETS.js.path}" defer></script>
</body>
</html>
`;
}

/** A two-pane workbench page. Without an inspector the list takes the whole width. */
export const workbench: typeof workbenchImpl = (...args) => span("render.workbench", () => workbenchImpl(...args));
function workbenchImpl(title: string, p: Panes, shell: Shell): string {
  const two = p.inspector !== null && (Boolean(p.inspectorKey) || p.focus === "inspector");
  const main = `<main class="panes${two ? "" : " one"}${two && p.stackOnPhone ? " wb-stacked" : ""}">
<section id="list" class="pane" data-key="${esc(p.listKey)}">${p.list}</section>
<div class="wb-resizer" role="separator" aria-label="Inspector width" aria-orientation="vertical" tabindex="0"></div>
<section id="inspector" class="pane" data-key="${esc(p.inspectorKey ?? "")}">${two && !p.inspector?.includes('data-close-inspector') ? '<button type="button" class="quiet wb-close" data-close-inspector aria-label="Close inspector">Close · Esc</button>' : ""}${two ? p.inspector : ""}</section>
</main>`;
  if (p.inspector && shell.breadcrumb && (p.inspectorKey || p.focus === "inspector")) {
    const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(p.inspector)?.[1];
    if (heading) {
      const entities: Record<string,string> = {amp:"&",lt:"<",gt:">",quot:'"',"#39":"'"};
      const text = heading.replace(/<form[\s\S]*?<\/form>/g, "").replace(/<span class="wb-pencil"[^>]*>[\s\S]*?<\/span>/g, "").replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (_, key: string) => entities[key]!).trim();
      if (text && text !== "Conversation") {
        const last = shell.breadcrumb.at(-1)!;
        const crumbs = last.selection ? [...shell.breadcrumb.slice(0,-1), {...last,label:text}] : last.label === text ? shell.breadcrumb : [...shell.breadcrumb.map(c=>({...c,current:false})), {label:text,href:last.href,current:true}];
        shell = {...shell,breadcrumb:crumbs};
      }
    }
  }
  return frame(title, main, shell, p.focus ?? (two && p.inspectorKey ? "inspector" : "list"));
}

export const page: typeof pageImpl = (...args) => span("render.page", () => pageImpl(...args));
function pageImpl(title: string, body: string, shell?: Shell): string {
  if (!shell) {
    return `${head(title)}
<body class="plain">
<header class="top"><a class="brand" href="/">Pimwell</a></header>
<main>
${body}
</main>
<footer><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
</body>
</html>
`;
  }
  return workbench(title, { list: body, listKey: `page:${title}`, inspector: null }, shell);
}

export const HTML_CSP = "default-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export function htmlResponse(body: string, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "no-store");
  h.set("referrer-policy", "same-origin");
  h.set("x-content-type-options", "nosniff");
  h.set("content-security-policy", HTML_CSP);
  h.set("x-frame-options", "DENY");
  return new Response(body, { status, headers: h });
}

/**
 * Copy buttons: a button with data-copy="#id" copies that element's text (or an input's value) and says so. The
 * workbench script handles it on swapped panes; this asset covers a page loaded on its own.
 */
export const COPY_SCRIPT = `<script src="${ASSETS.copy.path}" defer></script>`;
