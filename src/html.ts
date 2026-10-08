import { ASSETS } from "./assets";

const MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => MAP[ch]!);
}

export type RailLink = { href: string; label: string; active: boolean; count?: number | null; planned?: boolean };

/**
 * The signed-in frame, the workbench: a persistent rail, a top bar with jump and file, and panes. `nav` is the rail's
 * sections; `projects` and `planned` are its lower groups; `tabs` is the phone's bottom bar.
 */
export type Shell = {
  brandHref: string; org: { name: string; href: string } | null; nav: RailLink[]; me: { name: string; href: string }; tip: string;
  projects?: RailLink[]; planned?: RailLink[]; tabs?: RailLink[]; canFile?: boolean;
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
  `<li><a href="${esc(l.href)}"${l.active ? ' aria-current="page"' : ""}>${esc(l.label)}</a>${l.planned ? '<span class="pill">planned</span>' : ""}${typeof l.count === "number" && l.count > 0 ? `<span class="n">${l.count}</span>` : ""}</li>`;

/** Log out: a real POST to this host, then a page that does not need a session. */
export const logout = (back: string) => `<form class="inline" method="post" action="/api/session.end" data-reload><input type="hidden" name="_back" value="${esc(back)}"><button type="submit" class="link">Log out</button></form>`;

function frame(title: string, main: string, shell: Shell, focus: "list" | "inspector"): string {
  const org = shell.org !== null;
  const rail = `<aside id="rail" class="rail"><div class="railhead"><b>${esc(org ? shell.org!.name : "Pimwell")}</b><a class="close" href="#" aria-label="Close menu">✕ Close</a></div><nav aria-label="Primary"><ul>${shell.nav.map(railLink).join("")}</ul>
${shell.projects?.length ? `<h4>Projects</h4><ul>${shell.projects.map(railLink).join("")}</ul>` : ""}
${shell.planned?.length ? `<h4>Coming</h4><ul>${shell.planned.map(railLink).join("")}</ul>` : ""}</nav>
<h4>Your account</h4><ul><li><a href="${esc(shell.me.href)}">${esc(shell.me.name)}</a></li><li>${logout(org ? "/signed-out" : "/")}</li></ul></aside>`;
  const bar = `<header class="bar"><a class="menu" href="#rail" aria-label="Menu"><span aria-hidden="true">☰</span><span class="ml">Menu</span></a><a class="brand" href="${esc(shell.brandHref)}">Pimwell</a>${org ? `<a class="org" href="${esc(shell.org!.href)}">${esc(shell.org!.name)}</a>` : ""}
${org ? `<form class="jump" action="/jump" method="get" role="search"><input name="q" placeholder="Jump to… a project, person or site#3" autocomplete="off" aria-label="Jump to"><kbd>⌘K</kbd></form>` : `<span class="jump"></span>`}
${org && shell.canFile ? `<a class="button file" href="/new" title="File work (c)">+ File</a>` : ""}<a class="me" href="${esc(shell.me.href)}">${esc(shell.me.name)}</a></header>`;
  const tabs = shell.tabs?.length ? `<nav class="tabs" aria-label="Sections">${shell.tabs.map((t) => `<a href="${esc(t.href)}"${t.active ? ' aria-current="page"' : ""}>${esc(t.label)}${typeof t.count === "number" && t.count > 0 ? `<span class="n">${t.count}</span>` : ""}</a>`).join("")}<a href="#rail">More</a></nav>` : "";
  const status = `<footer class="status"><span id="perf"></span><span class="tip">${esc(shell.tip)}</span><span class="keys hide-s"><kbd>⌘K</kbd> jump · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>e</kbd> edit · <kbd>c</kbd> file · <kbd>/</kbd> filter</span><a href="${esc(shell.brandHref)}privacy">Privacy</a><a href="${esc(shell.brandHref)}terms">Terms</a></footer>`;
  return `${head(title)}
<body class="wb" data-focus="${focus}">
${bar}
${rail}
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

export function htmlResponse(body: string, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "no-store");
  h.set("referrer-policy", "same-origin");
  h.set("x-content-type-options", "nosniff");
  h.set("content-security-policy", "frame-ancestors 'none'");
  h.set("x-frame-options", "DENY");
  return new Response(body, { status, headers: h });
}
