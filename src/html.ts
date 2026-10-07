import { WORKBENCH_JS } from "./workbenchScript";

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

// One design system for every page (the workbench, 2026-10-07): a cool neutral, dense, light by default and dark
// when the system asks, system fonts only, no external requests. Old variable names stay as aliases.
const CSS = `
:root{--bg:#f2f4f7;--panel:#fff;--sunk:#eaeef2;--line:#d9dfe6;--ink:#17202b;--muted:#5d6a79;--faint:#8794a2;--accent:#1b7a69;--accent-soft:#dff0ec;--focus:#1b7a69;
--wish:#6d52de;--snag:#cc3d3d;--errand:#1b7a69;--quest:#a96f12;--call:#475569;--spark:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#0e1217;--panel:#151a21;--sunk:#1a2028;--line:#28313c;--ink:#e3e8ee;--muted:#9ba7b4;--faint:#6d7987;--accent:#45c1aa;--accent-soft:#163430;--focus:#45c1aa;
--wish:#a593ff;--snag:#ff8578;--errand:#45c1aa;--quest:#e2b04f;--call:#a8b4c3;--spark:#ff9b5e}}
:root{--paper:var(--bg);--card:var(--panel);--soft:var(--sunk);--teal:var(--accent);--violet:var(--wish);--coral:var(--snag);--gold:var(--quest)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums}
a{color:var(--accent);text-underline-offset:2px}
:focus-visible{outline:2px solid var(--focus);outline-offset:1px;border-radius:3px}
h1{font-size:20px;line-height:1.25;letter-spacing:-.01em;margin:2px 0 6px}h2{font-size:14px;margin:18px 0 6px}h3{font-size:13.5px;margin:2px 0}
.lede{color:var(--muted);max-width:46rem;margin:4px 0 10px}
.crumbs{color:var(--muted);font-size:12.5px;margin:0 0 2px}.crumbs a{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));gap:8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px 10px}
.card h3 a{color:var(--ink);text-decoration:none}.card p{margin:2px 0;color:var(--muted);font-size:13px}
.stat{font-size:20px;font-weight:700}.stat small{font-size:12px;color:var(--muted);font-weight:500;margin-left:4px}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 8px}.chip{display:inline-block;padding:1px 8px;border-radius:4px;background:var(--sunk);color:var(--ink);text-decoration:none;font-size:12.5px;border:1px solid transparent}
.chip[aria-current]{background:var(--ink);color:var(--panel)}.chips+.chips{margin-top:-4px}.chips .gap{width:8px}
form.filters{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 8px}form.filters label{margin:0}
.k-wish{color:var(--wish)}.k-snag{color:var(--snag)}.k-errand{color:var(--errand)}.k-quest{color:var(--quest)}.k-call{color:var(--call)}.k-spark{color:var(--spark)}
.kd{display:inline-block;width:8px;height:8px;border-radius:2px;background:currentColor;margin-right:6px;vertical-align:1px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:6px;overflow:hidden}
th,td{padding:4px 8px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:11.5px;color:var(--muted);font-weight:600;background:var(--sunk);position:sticky;top:0}
tr:last-child td{border-bottom:0}tr[data-href]{cursor:pointer}tr[data-href]:hover td{background:var(--sunk)}tr[aria-selected=true] td{background:var(--accent-soft)}
td.ref,td.when{white-space:nowrap;color:var(--muted);font-size:12.5px}td a{color:var(--ink);text-decoration:none}td a:hover{text-decoration:underline}
.timeline{list-style:none;padding:0;margin:0}.timeline li{display:grid;grid-template-columns:7rem 1fr;gap:8px;padding:3px 0;border-bottom:1px solid var(--line);font-size:13px}
.timeline time{color:var(--muted);font-size:12px}
button,.button{font:inherit;font-size:13px;font-weight:600;padding:3px 10px;border-radius:5px;border:1px solid var(--ink);background:var(--ink);color:var(--panel);cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.button:hover{background:var(--accent);border-color:var(--accent)}button.quiet,.button.quiet{background:var(--panel);color:var(--ink);border-color:var(--line)}
button:disabled{opacity:.5;cursor:not-allowed}
input,select,textarea{font:inherit;font-size:13px;padding:3px 7px;border:1px solid var(--line);border-radius:5px;background:var(--panel);color:var(--ink);max-width:100%}
label{display:inline-block;margin:3px 8px 3px 0}
form.inline{display:inline}pre{white-space:pre-wrap;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px;font-size:12.5px}
code,kbd{background:var(--sunk);padding:0 4px;border-radius:3px;font-size:12px}
.prose{white-space:pre-wrap;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px 10px;max-width:46rem}
blockquote{margin:6px 0;padding:4px 10px;border-left:3px solid var(--accent);color:var(--muted);background:var(--sunk);border-radius:0 4px 4px 0}
details.edit{margin:8px 0;max-width:46rem}details.edit summary{cursor:pointer;font-weight:650;color:var(--accent)}details.edit label{display:block;margin:6px 0}
details.edit label>input,details.edit label>textarea{display:block;width:100%;margin-top:2px}details.edit label>select{display:block;margin-top:2px}details.edit .row{display:flex;flex-wrap:wrap;gap:0 12px}
.tip:before{content:"Old constraints, gone: ";font-weight:650;color:var(--accent)}
.pill{display:inline-block;font-size:10.5px;font-weight:650;padding:0 5px;border-radius:3px;background:var(--sunk);color:var(--muted);border:1px solid var(--line);vertical-align:1px;margin-left:4px}
.planned{border:1px dashed var(--line);border-radius:6px;padding:6px 10px;margin:8px 0;color:var(--muted);font-size:13px}.planned b{color:var(--ink)}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;font-size:13px;margin:6px 0}.meta dt{color:var(--muted)}.meta dd{margin:0}
.head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:12.5px}
.empty{color:var(--muted);padding:24px 8px;text-align:center}
.plain{background:var(--bg)}.plain main{max-width:40rem;margin:0 auto;padding:40px 16px}.plain .top{padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
.plain .brand,.bar .brand{font-weight:800;color:var(--ink);text-decoration:none}.plain footer{max-width:40rem;margin:0 auto;padding:16px;color:var(--muted);font-size:12.5px}
body.wb{height:100vh;height:100dvh;display:grid;grid-template-columns:208px minmax(0,1fr);grid-template-rows:42px minmax(0,1fr) 24px;grid-template-areas:"bar bar" "rail main" "status status";overflow:hidden}
.bar{grid-area:bar;display:flex;align-items:center;gap:10px;padding:0 10px;background:var(--panel);border-bottom:1px solid var(--line);min-width:0}
.bar .org{color:var(--muted);text-decoration:none;font-weight:600;white-space:nowrap}.bar .org:before{content:"/";margin-right:8px;color:var(--line)}
.bar .menu{display:none;text-decoration:none;color:var(--ink);font-size:18px}.bar .me{color:var(--muted);text-decoration:none;font-size:12.5px;white-space:nowrap}
.jump{position:relative;flex:1;max-width:520px;margin:0 auto}.jump input{width:100%;padding:4px 8px 4px 8px;background:var(--sunk)}
.jump kbd{position:absolute;right:6px;top:5px;color:var(--faint)}
.jump ul{position:absolute;left:0;right:0;top:30px;margin:0;padding:4px;list-style:none;background:var(--panel);border:1px solid var(--line);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:30}
.jump li a{display:flex;justify-content:space-between;gap:8px;padding:4px 8px;border-radius:4px;color:var(--ink);text-decoration:none}.jump li a small{color:var(--muted)}
.jump li[aria-selected=true] a,.jump li a:hover{background:var(--accent-soft)}
.rail{grid-area:rail;overflow:auto;background:var(--sunk);border-right:1px solid var(--line);padding:8px 6px 16px;font-size:13px}
.rail ul{list-style:none;margin:0 0 6px;padding:0}.rail li{display:flex;align-items:center;border-radius:4px}
.rail li a{flex:1;padding:3px 8px;color:var(--ink);text-decoration:none;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rail li:hover{background:var(--line)}.rail li a[aria-current]{font-weight:700}.rail li:has(a[aria-current]){background:var(--panel);box-shadow:inset 2px 0 0 var(--accent)}
.rail .n{color:var(--muted);font-size:12px;padding-right:8px}.rail h4{margin:10px 8px 2px;font-size:11px;color:var(--faint);font-weight:650;letter-spacing:.02em}
.rail .close{display:none}
.panes{grid-area:main;display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,44%);min-height:0}
.panes.one{grid-template-columns:minmax(0,1fr)}.panes.one #inspector{display:none}
.pane{overflow:auto;min-height:0;padding:10px 14px 24px}.panes:not(.one) #list{border-right:1px solid var(--line)}#inspector{background:var(--panel)}
.pane .back{display:none}
.status{grid-area:status;display:flex;align-items:center;gap:14px;padding:0 10px;border-top:1px solid var(--line);background:var(--panel);font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden}
.status a{color:var(--muted)}.status .keys{margin-left:auto}
.tabs{display:none}
@media (max-width:1100px){body.wb{grid-template-columns:minmax(0,1fr);grid-template-areas:"bar" "main" "status"}
.rail{position:fixed;top:42px;bottom:0;left:0;width:270px;z-index:25;transform:translateX(-102%);transition:transform .16s ease;box-shadow:8px 0 24px rgba(0,0,0,.15)}
.rail:target,.rail.open{transform:none}.rail .close{display:block;padding:2px 8px 8px;color:var(--muted)}.bar .menu{display:inline}}
@media (max-width:760px){body.wb{grid-template-rows:42px minmax(0,1fr) 50px;grid-template-areas:"bar" "main" "tabs"}
.status{display:none}.bar .org,.bar .me,.jump kbd{display:none}.bar .file{padding:3px 8px}
.panes{grid-template-columns:minmax(0,1fr)}body[data-focus=inspector] #list{display:none}body[data-focus=list] #inspector{display:none}
.panes:not(.one) #list{border-right:0}.pane{padding:8px 10px 20px}.pane .back{display:inline-block;margin-bottom:4px}
.tabs{grid-area:tabs;display:flex;border-top:1px solid var(--line);background:var(--panel)}
.tabs a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:11.5px;color:var(--muted);text-decoration:none}
.tabs a[aria-current]{color:var(--accent);font-weight:700}.tabs .n{font-size:10.5px}
.hide-s{display:none}.timeline li{grid-template-columns:1fr;gap:0}}
@media (prefers-reduced-motion:reduce){.rail{transition:none}}
`;

const head = (title: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>`;

const railLink = (l: RailLink) =>
  `<li><a href="${esc(l.href)}"${l.active ? ' aria-current="page"' : ""}>${esc(l.label)}</a>${l.planned ? '<span class="pill">planned</span>' : ""}${typeof l.count === "number" && l.count > 0 ? `<span class="n">${l.count}</span>` : ""}</li>`;

function frame(title: string, main: string, shell: Shell, focus: "list" | "inspector"): string {
  const rail = `<aside id="rail" class="rail"><a class="close" href="#">Close menu</a><nav aria-label="Primary"><ul>${shell.nav.map(railLink).join("")}</ul>
${shell.projects?.length ? `<h4>Projects</h4><ul>${shell.projects.map(railLink).join("")}</ul>` : ""}
${shell.planned?.length ? `<h4>Coming</h4><ul>${shell.planned.map(railLink).join("")}</ul>` : ""}</nav></aside>`;
  const org = shell.org !== null;
  const bar = `<header class="bar"><a class="menu" href="#rail" aria-label="Menu">☰</a><a class="brand" href="${esc(shell.brandHref)}">Pimwell</a>${org ? `<a class="org" href="${esc(shell.org!.href)}">${esc(shell.org!.name)}</a>` : ""}
${org ? `<form class="jump" action="/jump" method="get" role="search"><input name="q" placeholder="Jump to… site#3, a project, a person" autocomplete="off" aria-label="Jump to"><kbd>⌘K</kbd></form>` : `<span class="jump"></span>`}
${org && shell.canFile ? `<a class="button file" href="/new" title="File work (c)">+ File</a>` : ""}<a class="me" href="${esc(shell.me.href)}">${esc(shell.me.name)}</a></header>`;
  const tabs = shell.tabs?.length ? `<nav class="tabs" aria-label="Sections">${shell.tabs.map((t) => `<a href="${esc(t.href)}"${t.active ? ' aria-current="page"' : ""}>${esc(t.label)}${typeof t.count === "number" && t.count > 0 ? `<span class="n">${t.count}</span>` : ""}</a>`).join("")}<a href="#rail">More</a></nav>` : "";
  const status = `<footer class="status"><span id="perf"></span><span class="tip">${esc(shell.tip)}</span><span class="keys hide-s"><kbd>⌘K</kbd> jump · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>e</kbd> edit · <kbd>c</kbd> file · <kbd>/</kbd> filter</span><a href="${esc(shell.brandHref)}privacy">Privacy</a><a href="${esc(shell.brandHref)}terms">Terms</a></footer>`;
  return `${head(title)}
<body class="wb" data-focus="${focus}">
${bar}
${rail}
${main}
${status}
${tabs}
<script>${WORKBENCH_JS}</script>
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
