import { ASSETS } from "./assets";

const MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => MAP[ch]!);
}

/** Kit slots named `html` contain trusted, already-escaped server markup; labels are plain text. */
export type KitLink = { label: string; href: string; current?: boolean; count?: number };
const kitHref = (href: string) => esc(/^(\/(?!\/)|https?:\/\/|mailto:|#)/i.test(href) ? href : "#");
const kitLink = (l: KitLink) => `<a href="${kitHref(l.href)}"${l.current ? ' aria-current="page"' : ""}>${esc(l.label)}${l.count !== undefined ? `<span class="wb-count">${esc(String(l.count))}</span>` : ""}</a>`;

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

export type TreeNode = KitLink & { children?: TreeNode[]; expanded?: boolean };
/** Native details supplies accessible keyboard expand/collapse without inline scripts. */
export function kitTree(label: string, nodes: TreeNode[]): string {
  const branch = (items: TreeNode[]): string => `<ul>${items.map(n => `<li>${n.children ? `<details${n.expanded ? " open" : ""}><summary>${esc(n.label)}${n.count !== undefined ? `<span class="wb-count">${esc(String(n.count))}</span>` : ""}</summary>${kitLink({...n, label: `Open ${n.label}`, count: undefined})}${branch(n.children)}</details>` : kitLink(n)}</li>`).join("")}</ul>`;
  return `<nav class="wb-tree" aria-label="${esc(label)}">${branch(nodes)}</nav>`;
}

export type ChipTone = "open" | "doing" | "done" | "dropped" | "blocked" | "wish" | "snag" | "errand" | "quest" | "call" | "spark";
export function statusChip(label: string, tone: ChipTone): string {
  return `<span class="wb-chip wb-tone-${esc(tone)}">${esc(label)}</span>`;
}

export function inspectorSection(heading: string, rows: { label: string; html: string; editHtml?: string }[], actionsHtml = ""): string {
  return `<section class="wb-section"><h2>${esc(heading)}</h2><dl>${rows.map(r => `<dt>${esc(r.label)}</dt><dd>${r.html}${r.editHtml ? `<details class="wb-inline-edit"><summary>Edit ${esc(r.label)}</summary>${r.editHtml}</details>` : ""}</dd>`).join("")}</dl>${actionsHtml}</section>`;
}

export function formRow(id: string, label: string, controlHtml: string, hint = ""): string {
  return `<div class="wb-form-row"><label for="${esc(id)}">${esc(label)}</label><div>${controlHtml}${hint ? `<p class="wb-hint" id="${esc(id)}-hint">${esc(hint)}</p>` : ""}</div></div>`;
}

export function emptyState(heading: string, description: string, action: KitLink): string {
  return `<section class="wb-empty"><h2>${esc(heading)}</h2><p>${esc(description)}</p>${kitLink(action)}</section>`;
}

export type RailLink = { href: string; label: string; active: boolean; count?: number | null; planned?: boolean };

/**
 * The signed-in frame, the workbench: a persistent rail, a top bar with jump and file, and panes. `nav` is the rail's
 * sections; `projects` and `planned` are its lower groups; `tabs` is the phone's bottom bar.
 */
export type Shell = {
  brandHref: string; org: { name: string; href: string } | null; nav: RailLink[]; me: { name: string; email: string; role: string | null; href: string }; tip: string;
  projects?: RailLink[]; planned?: RailLink[]; tabs?: RailLink[]; canFile?: boolean;
  breadcrumb?: KitLink[]; explorer?: string; projectPath?: string; inProject?: boolean; preferenceKey?: string;
};

/** Two panes: a list and an inspector. Keys tell the script which pane changed, so the other keeps its place. */
export type Panes = { list: string; listKey: string; inspector: string | null; inspectorKey?: string; focus?: "list" | "inspector" };



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
export const logout = (back: string) => `<form class="inline" method="post" action="/api/session.end" data-reload><input type="hidden" name="_back" value="${esc(back)}"><button type="submit" class="link">Log out</button></form>`;

function frame(title: string, main: string, shell: Shell, focus: "list" | "inspector"): string {
  const org = shell.org !== null;
  const rail = `<aside id="rail" class="rail"><div class="railhead"><b>${esc(org ? shell.org!.name : "Pimwell")}</b><a class="close" href="#" aria-label="Close menu">✕ Close</a></div>${kitTree("Primary", shell.nav.map(l => ({href: l.href, label: l.label, current: l.active, count: l.count ?? undefined})))}
${shell.projects?.length ? `<h4>Projects</h4><ul>${shell.projects.map(railLink).join("")}</ul>` : ""}
${shell.planned?.length ? `<h4>Coming</h4><ul>${shell.planned.map(railLink).join("")}</ul>` : ""}
<h4>Your account</h4><ul><li><a href="${esc(shell.me.href)}">${esc(shell.me.name)}</a></li><li class="account-details">${esc(shell.me.email)}${shell.me.role ? `<span>Role: ${esc(shell.me.role)}</span>` : ""}</li><li>${logout(org ? "/signed-out" : "/")}</li></ul></aside>`;
  const explorer = `<aside id="explorer" class="explorer" aria-label="Project explorer" data-project="${esc(shell.projectPath ?? "")}" data-in-project="${shell.inProject ? "1" : "0"}" data-preference="${esc(shell.preferenceKey ?? "")}"><div class="railhead"><b>Project explorer</b><a class="close" href="#" aria-label="Close project explorer">✕ Close</a></div>${shell.explorer ?? '<p>Open an organization to explore its projects.</p>'}</aside>`;
  const bar = `<header class="bar"><a class="menu" href="#rail" aria-label="Menu"><span aria-hidden="true">☰</span><span class="ml">Menu</span></a><a class="explorer-toggle" href="#explorer">Project</a>${breadcrumb(shell.breadcrumb ?? [{label: shell.org?.name ?? "Pimwell", href: shell.org?.href ?? shell.brandHref}, {label: title, href: "#", current: true}])}
${org ? `<form class="jump" action="/search" method="get" role="search"><input name="q" placeholder="Search all projects…" maxlength="200" autocomplete="off" aria-label="Search all projects"><kbd>⌘K</kbd></form>` : `<span class="jump"></span>`}
${org && shell.canFile ? `<a class="button file" href="/new" title="File work (c)">+ File</a>` : ""}<a class="me" href="${esc(shell.me.href)}">${esc(shell.me.email)}${shell.me.role ? ` (${esc(shell.me.role)})` : ""}</a></header>`;
  const tabs = shell.tabs?.length ? `<nav class="tabs" aria-label="Sections">${shell.tabs.map((t) => `<a href="${esc(t.href)}"${t.active ? ' aria-current="page"' : ""}>${esc(t.label)}${typeof t.count === "number" && t.count > 0 ? `<span class="n">${t.count}</span>` : ""}</a>`).join("")}<a href="#rail">More</a></nav>` : "";
  const status = `<footer class="status"><span id="perf"></span><span class="tip">${esc(shell.tip)}</span><span class="keys hide-s"><kbd>⌘K</kbd> search · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>e</kbd> edit · <kbd>c</kbd> file · <kbd>/</kbd> filter</span><a href="${esc(shell.brandHref)}privacy">Privacy</a><a href="${esc(shell.brandHref)}terms">Terms</a></footer>`;
  return `${head(title)}
<body class="wb" data-focus="${focus}">
${bar}
${rail}
${explorer}
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
export function workbench(title: string, p: Panes, shell: Shell): string {
  const two = p.inspector !== null;
  const main = `<main class="panes${two ? "" : " one"}">
<section id="list" class="pane" data-key="${esc(p.listKey)}">${p.list}</section>
<section id="inspector" class="pane" data-key="${esc(p.inspectorKey ?? "")}">${p.inspector ?? ""}</section>
</main>`;
  return frame(title, main, shell, p.focus ?? (two && p.inspectorKey ? "inspector" : "list"));
}

export function page(title: string, body: string, shell?: Shell): string {
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

/** Getting someone started: connect an agent (members and up) and invite a person (admins), as one matching pair. */
export function onramp(opts: { connect: boolean; invite: boolean }): string {
  const a: string[] = [];
  if (opts.connect) a.push(`<a href="/people?connect=1"><b>Connect an agent</b><span>Claude Code, Codex or any agent: one link to paste to it</span></a>`);
  if (opts.invite) a.push(`<a href="/people?invite=1"><b>Invite a person</b><span>A link to send them; they sign in with Google or email</span></a>`);
  return a.length ? `<div class="onramp">${a.join("")}</div>` : "";
}

/**
 * Copy buttons: a button with data-copy="#id" copies that element's text (or an input's value) and says so. The
 * workbench script handles it on swapped panes; this asset covers a page loaded on its own.
 */
export const COPY_SCRIPT = `<script src="${ASSETS.copy.path}" defer></script>`;
