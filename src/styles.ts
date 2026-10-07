// Components for every page, written only in the theme's variables (src/theme.ts).
export const COMPONENTS_CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:var(--fs)/1.45 var(--font);font-variant-numeric:tabular-nums}
a{color:var(--accent);text-underline-offset:2px}
:focus-visible{outline:2px solid var(--focus);outline-offset:1px;border-radius:var(--r-xs)}
h1{font-size:var(--fs-h1);line-height:1.25;letter-spacing:-.01em;margin:2px 0 6px}h2{font-size:14px;margin:18px 0 6px}h3{font-size:13.5px;margin:2px 0}
.lede{color:var(--muted);max-width:46rem;margin:4px 0 10px}
.crumbs{color:var(--muted);font-size:var(--fs-sm);margin:0 0 2px}.crumbs a{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));gap:8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:8px 10px}
.card h3 a{color:var(--ink);text-decoration:none}.card p{margin:2px 0;color:var(--muted);font-size:var(--fs-md)}
.stat{font-size:20px;font-weight:700}.stat small{font-size:12px;color:var(--muted);font-weight:500;margin-left:4px}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 8px}.chip{display:inline-block;padding:1px 8px;border-radius:var(--r-sm);background:var(--sunk);color:var(--ink);text-decoration:none;font-size:var(--fs-sm);border:1px solid transparent}
.chip[aria-current]{background:var(--ink);color:var(--panel)}.chips+.chips{margin-top:-4px}.chips .gap{width:8px}
form.filters{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 8px}form.filters label{margin:0}
.k-wish{color:var(--wish)}.k-snag{color:var(--snag)}.k-errand{color:var(--errand)}.k-quest{color:var(--quest)}.k-call{color:var(--call)}.k-spark{color:var(--spark)}
.kd{display:inline-block;width:8px;height:8px;border-radius:2px;background:currentColor;margin-right:6px;vertical-align:1px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
th,td{padding:4px 8px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:var(--fs-xs);color:var(--muted);font-weight:600;background:var(--sunk);position:sticky;top:0}
tr:last-child td{border-bottom:0}tr[data-href]{cursor:pointer}tr[data-href]:hover td{background:var(--sunk)}tr[aria-selected=true] td{background:var(--accent-soft)}
td[class^=k-]{white-space:nowrap}td.ref,td.when{white-space:nowrap;color:var(--muted);font-size:var(--fs-sm)}td a{color:var(--ink);text-decoration:none}td a:hover{text-decoration:underline}
.timeline{list-style:none;padding:0;margin:0}.timeline li{display:grid;grid-template-columns:7rem 1fr;gap:8px;padding:3px 0;border-bottom:1px solid var(--line);font-size:var(--fs-md)}
.timeline time{color:var(--muted);font-size:12px}#inspector .timeline li{grid-template-columns:3.2rem 1fr}
button,.button{font:inherit;font-size:var(--fs-md);font-weight:600;padding:3px 10px;border-radius:var(--r-sm);border:1px solid var(--ink);background:var(--ink);color:var(--panel);cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.button:hover{background:var(--accent);border-color:var(--accent)}button.quiet,.button.quiet{background:var(--panel);color:var(--ink);border-color:var(--line)}
button:disabled{opacity:.5;cursor:not-allowed}
button.link{background:none;border:0;padding:3px 8px;color:var(--ink);font-weight:500;cursor:pointer}button.link:hover{background:none;color:var(--accent);text-decoration:underline}
a.card{display:block;color:inherit;text-decoration:none}a.card:hover{border-color:var(--accent);box-shadow:var(--shadow)}a.card h3{color:var(--ink)}.card.big{padding:14px 16px}.card.big h3{font-size:16px}
input,select,textarea{font:inherit;font-size:var(--fs-md);padding:3px 7px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--panel);color:var(--ink);max-width:100%}
label{display:inline-block;margin:3px 8px 3px 0}
form.inline{display:inline}pre{white-space:pre-wrap;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:8px;font-size:var(--fs-sm)}
code,kbd{background:var(--sunk);padding:0 4px;border-radius:var(--r-xs);font-size:12px}
.prose{white-space:pre-wrap;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:8px 10px;max-width:46rem}
blockquote{margin:6px 0;padding:4px 10px;border-left:3px solid var(--accent);color:var(--muted);background:var(--sunk);border-radius:0 4px 4px 0}
details.edit{margin:8px 0;max-width:46rem}details.edit summary{cursor:pointer;font-weight:650;color:var(--accent)}details.edit label{display:block;margin:6px 0}
details.edit label>input,details.edit label>textarea{display:block;width:100%;margin-top:2px}details.edit label>select{display:block;margin-top:2px}details.edit .row{display:flex;flex-wrap:wrap;gap:0 12px}
.tip:before{content:"Old constraints, gone: ";font-weight:650;color:var(--accent)}
.pill{display:inline-block;font-size:10.5px;font-weight:650;padding:0 5px;border-radius:var(--r-xs);background:var(--sunk);color:var(--muted);border:1px solid var(--line);vertical-align:1px;margin-left:4px}
.planned{border:1px dashed var(--line);border-radius:var(--r);padding:6px 10px;margin:8px 0;color:var(--muted);font-size:var(--fs-md)}.planned b{color:var(--ink)}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;font-size:var(--fs-md);margin:6px 0}.meta dt{color:var(--muted)}.meta dd{margin:0}
.head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:var(--fs-sm)}
.empty{color:var(--muted);padding:24px 8px;text-align:center}
.plain{background:var(--bg)}.plain main{max-width:40rem;margin:0 auto;padding:40px 16px}.plain .top{padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
.plain .brand,.bar .brand{font-weight:800;color:var(--ink);text-decoration:none}.plain footer{max-width:40rem;margin:0 auto;padding:16px;color:var(--muted);font-size:var(--fs-sm)}
body.wb{height:100vh;height:100dvh;display:grid;grid-template-columns:var(--rail-w) minmax(0,1fr);grid-template-rows:var(--bar-h) minmax(0,1fr) var(--status-h);grid-template-areas:"bar bar" "rail main" "status status";overflow:hidden}
.bar{grid-area:bar;display:flex;align-items:center;gap:10px;padding:0 10px;background:var(--panel);border-bottom:1px solid var(--line);min-width:0}
.bar .org{color:var(--muted);text-decoration:none;font-weight:600;white-space:nowrap}.bar .org:before{content:"/";margin-right:8px;color:var(--line)}
.bar .menu{display:none;text-decoration:none;color:var(--ink);font-size:18px}.bar .me{color:var(--muted);text-decoration:none;font-size:var(--fs-sm);white-space:nowrap}
.jump{position:relative;flex:1;max-width:520px;margin:0 auto}.jump input{width:100%;padding:4px 8px 4px 8px;background:var(--sunk)}
.jump kbd{position:absolute;right:6px;top:5px;color:var(--faint)}
.jump ul{position:absolute;left:0;right:0;top:30px;margin:0;padding:4px;list-style:none;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);z-index:30}
.jump li a{display:flex;justify-content:space-between;gap:8px;padding:4px 8px;border-radius:var(--r-sm);color:var(--ink);text-decoration:none}.jump li a small{color:var(--muted)}
.jump li[aria-selected=true] a,.jump li a:hover{background:var(--accent-soft)}
.rail{grid-area:rail;overflow:auto;background:var(--sunk);border-right:1px solid var(--line);padding:8px 6px 16px;font-size:var(--fs-md)}
.rail ul{list-style:none;margin:0 0 6px;padding:0}.rail li{display:flex;align-items:center;border-radius:var(--r-sm)}
.rail li a{flex:1;padding:3px 8px;color:var(--ink);text-decoration:none;border-radius:var(--r-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rail li:hover{background:var(--line)}.rail li a[aria-current]{font-weight:700}.rail li:has(a[aria-current]){background:var(--panel);box-shadow:inset 2px 0 0 var(--accent)}
.rail .n{color:var(--muted);font-size:12px;padding-right:8px}.rail h4{margin:10px 8px 2px;font-size:11px;color:var(--faint);font-weight:650;letter-spacing:.02em}
.rail .close{display:none}
.panes{grid-area:main;display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,44%);min-height:0}
.panes.one{grid-template-columns:minmax(0,1fr)}.panes.one #inspector{display:none}
.pane{overflow:auto;min-height:0;padding:10px 14px 24px}.panes:not(.one) #list{border-right:1px solid var(--line)}#inspector{background:var(--panel)}
.pane .back{display:none}
.status{grid-area:status;display:flex;align-items:center;gap:14px;padding:0 10px;border-top:1px solid var(--line);background:var(--panel);font-size:var(--fs-xs);color:var(--muted);white-space:nowrap;overflow:hidden}
.status a{color:var(--muted)}.status .keys{margin-left:auto}
.tabs{display:none}
@media (max-width:1100px){body.wb{grid-template-columns:minmax(0,1fr);grid-template-areas:"bar" "main" "status"}
.rail{position:fixed;top:var(--bar-h);bottom:0;left:0;width:270px;z-index:25;transform:translateX(-102%);transition:transform .16s ease;box-shadow:var(--shadow)}
.rail:target,.rail.open{transform:none}.rail .close{display:block;padding:2px 8px 8px;color:var(--muted)}.bar .menu{display:inline}}
@media (max-width:760px){body.wb{grid-template-rows:var(--bar-h) minmax(0,1fr) 50px;grid-template-areas:"bar" "main" "tabs"}
.status{display:none}.bar .org,.bar .me,.jump kbd{display:none}.bar .file{padding:3px 8px}
.panes{grid-template-columns:minmax(0,1fr)}body[data-focus=inspector] #list{display:none}body[data-focus=list] #inspector{display:none}
.panes:not(.one) #list{border-right:0}.pane{padding:8px 10px 20px}.pane .back{display:inline-block;margin-bottom:4px}
.tabs{grid-area:tabs;display:flex;border-top:1px solid var(--line);background:var(--panel)}
.tabs a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:var(--fs-xs);color:var(--muted);text-decoration:none}
.tabs a[aria-current]{color:var(--accent);font-weight:700}.tabs .n{font-size:10.5px}
.hide-s{display:none}.timeline li{grid-template-columns:1fr;gap:0}}
@media (prefers-reduced-motion:reduce){.rail{transition:none}}
`;
