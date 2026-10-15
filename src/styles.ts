// Components for every page, written only in the theme's variables (src/theme.ts).
export const COMPONENTS_CSS = `
/* Shared workbench kit. Scoped classes let later passes migrate one view at a time. */
.wb-org-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3);margin:var(--space-3) 0}
.wb-org-card{display:flex;flex-direction:column;gap:var(--space-2);min-width:0;padding:var(--space-4);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:var(--r);background:linear-gradient(120deg,var(--accent-soft),var(--panel));color:var(--ink);text-decoration:none;box-shadow:var(--elevation-1);transition:box-shadow .15s,border-color .15s}
.wb-org-card:hover{border-color:var(--accent);box-shadow:var(--elevation-2)}
.wb-org-heading{display:flex;align-items:start;justify-content:space-between;gap:var(--space-2)}.wb-org-heading strong{font-size:var(--fs-h1);overflow-wrap:anywhere}.wb-org-role{font-size:var(--fs-xs);border:1px solid var(--line);border-radius:var(--r-sm);padding:2px 7px;background:var(--panel);color:var(--muted)}
.wb-org-address{font-family:var(--mono);font-size:var(--fs-sm);color:var(--muted);overflow-wrap:anywhere}.wb-org-open{color:var(--accent);font-weight:600;margin-top:var(--space-2)}
.landing{max-width:960px}.landing-hero{padding:var(--space-3) 0}.landing-hero .lede{margin-bottom:var(--space-3)}.landing-heading{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap}.landing-heading h2{margin:0;font-size:var(--fs-h1)}
.landing-setup{margin-top:var(--space-4);padding:var(--space-4);background:var(--sunk);border:1px solid var(--line);border-radius:var(--r)}.landing-setup h2{margin:0;font-size:var(--fs-h1)}.landing-setup ol{padding-left:20px}.landing-setup li{margin:var(--space-2) 0}.landing-secondary{margin-top:var(--space-4);border-top:1px solid var(--line);padding-top:var(--space-3)}
.landing-create{margin:var(--space-3) 0}.landing-create>summary{display:inline-flex;align-items:center;list-style:none;cursor:pointer;background:var(--accent);color:var(--on-primary);border:1px solid var(--accent);border-radius:var(--r-sm);padding:6px 12px;font-weight:600}.landing-create>summary::-webkit-details-marker{display:none}.landing-create[open]>summary{margin-bottom:var(--space-2)}
@media(max-width:760px){.wb-org-grid{grid-template-columns:1fr}.landing-create>summary{min-height:var(--tap)}}
.wb-breadcrumb ol{display:flex;flex-wrap:wrap;list-style:none;padding:0;margin:0 0 var(--space-2);gap:var(--space-1);font-size:var(--fs-sm)}
.wb-breadcrumb li+li:before{content:"›";margin-right:var(--space-1);color:var(--faint)}
.wb-breadcrumb a{color:var(--muted);text-decoration:none}
.wb-tabs,.wb-toolbar,.wb-actions{display:flex;align-items:center;flex-wrap:wrap;gap:var(--space-2)}
.wb-tabs{border-bottom:var(--separator) solid var(--line);margin-bottom:var(--space-2)}
.wb-tabs a{padding:var(--space-1) var(--space-2);min-height:var(--row-h);display:inline-flex;align-items:center;text-decoration:none;color:var(--muted);border-bottom:2px solid transparent}
.wb-tabs a[aria-current]{color:var(--accent);border-bottom-color:var(--accent)}
.wb-toolbar{padding:var(--space-1) 0;border-bottom:var(--separator) solid var(--line);margin-bottom:var(--space-2);justify-content:space-between}
.wb-filters{min-width:0;max-width:100%}.wb-filters .filters{margin:0}.wb-filters label{max-width:100%}.wb-filters select{max-width:200px}
.wb-count{margin-left:var(--space-2);color:var(--muted);font-variant-numeric:tabular-nums}
.wb-table-wrap{max-width:100%;overflow-x:auto}.wb-table{width:100%;border-collapse:collapse;table-layout:auto}
.pane table th,.pane table td,.pane table th *,.pane table td *{overflow-wrap:normal;word-break:normal;hyphens:none}.perf-waterfall span{white-space:nowrap}.wb-table th{white-space:nowrap}.wb-table th,.wb-table td{height:var(--row-h);padding:3px var(--space-2);border-bottom:var(--separator) solid var(--line)}
.pane{overflow-wrap:anywhere}
.perf-stack{display:block;min-width:100px;margin-top:4px}.perf-spark{display:block}.perf-waterfall{padding:var(--space-2) 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.perf-waterfall strong,.perf-waterfall span,.perf-waterfall small{display:block}.perf-waterfall span,.perf-waterfall small{font-size:var(--fs-sm);color:var(--muted)}.perf-waterfall svg{display:block;margin:4px 0}#inspector h1 code{overflow-wrap:anywhere}#inspector pre{overflow-wrap:anywhere}
.wb-code .wb-table{font-family:var(--mono)}.wb-code .wb-table td{padding:0 var(--space-2);height:auto;white-space:pre;overflow-wrap:normal}.wb-code code{font-size:var(--fs-sm);background:none;padding:0}.wb-code .ln{color:var(--faint);width:1%;white-space:nowrap!important;text-align:right;user-select:none}.wb-code .ins{background:var(--add-bg)}.wb-code .dl{background:var(--del-bg)}.wb-code .hunk{background:var(--sunk);color:var(--muted)}
.wb-table tr[aria-selected=true]{background:var(--accent-soft)}
.wb-table tr[data-href]:hover{background:var(--sunk)}
.wb-tree ul{list-style:none;padding:0;margin:0}
.wb-tree ul ul{padding-left:var(--space-4);border-left:var(--separator) solid var(--line)}
.wb-tree a,.wb-tree summary{min-height:var(--row-h);padding:var(--space-1) var(--space-2);color:var(--ink);text-decoration:none;overflow-wrap:anywhere}
.wb-tree a{display:block}.wb-tree summary{cursor:pointer;display:flex;align-items:center;padding:0;list-style:none}.wb-tree summary::-webkit-details-marker{display:none}.wb-tree summary a{flex:1;min-width:0}.wb-tree a[aria-current]{background:var(--accent-soft);color:var(--accent)}
.wb-state{border:0!important;padding:0!important}.wb-board-columns{display:grid;gap:var(--space-2)}.wb-board-columns>section{min-width:0}@media(min-width:1280px){.wb-board-columns{grid-template-columns:repeat(3,minmax(0,1fr))}}.wb-comment{display:flex;align-items:start;gap:4px}.wb-comment textarea{width:100%;height:28px;min-height:28px;resize:vertical}.wb-comment:focus-within textarea{height:96px}.wb-comment button{padding:3px 6px}.wb-comment .voicebar{display:none;margin:0}.wb-comment:focus-within .voicebar{display:flex}.wb-comment .mic{width:28px;height:28px}.mail-message-text{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}.wb-list-no-heading thead{display:none}.wb-toolbar a:not(.wb-tabs a),.wb-toolbar button{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:var(--r-sm);padding:3px 8px;text-decoration:none}.wb-toolbar .wb-actions a.primary{background:var(--ink);color:var(--panel)}#connection-state:not(:empty):before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);margin-right:4px}.wb-chip{display:inline-flex;align-items:center;gap:var(--space-1);font-size:var(--fs-sm);white-space:nowrap;border:var(--separator) solid var(--line);border-radius:var(--r-xs);padding:0 var(--space-1)}
.wb-readiness .wb-chip{max-width:100%;white-space:normal;overflow-wrap:anywhere}.wb-readiness{display:inline-block;max-width:260px}.wb-readiness-compact{width:160px;max-width:160px;vertical-align:middle}.wb-readiness-compact .wb-chip:before{display:inline-block;margin-right:var(--space-1)}.wb-readiness-compact .wb-chip{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wb-priority{white-space:nowrap}@media(max-width:760px){.wb-readiness-compact{width:80px;max-width:80px}}.wb-dependency-graph{display:flex;flex-direction:column;gap:var(--space-2)}.wb-dependency-graph section{border-left:3px solid var(--line);padding-left:var(--space-2)}.wb-dependency-graph h2{margin:var(--space-1) 0}.wb-dependency-graph .wb-chip{white-space:normal}.wb-chip:before{flex-shrink:0;content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.wb-tone-open{color:var(--state-open)}.wb-tone-doing{color:var(--state-doing)}.wb-tone-done{color:var(--state-done)}.wb-tone-dropped{color:var(--state-dropped)}.wb-tone-blocked{color:var(--state-blocked)}
.wb-tone-wish{color:var(--wish)}.wb-tone-snag{color:var(--snag)}.wb-tone-errand{color:var(--errand)}.wb-tone-quest{color:var(--quest)}.wb-tone-call{color:var(--call)}.wb-tone-spark{color:var(--spark)}
.overview .wb-actions{flex-wrap:wrap!important}.overview .wb-actions form{margin:0}.overview .wb-section dl{grid-template-columns:80px minmax(0,1fr)}
.wb-section{border-bottom:var(--separator) solid var(--line);padding:var(--space-2) 0}.wb-section h2{margin:0 0 var(--space-2);font-size:var(--fs-md)}
.wb-section dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:var(--space-1) var(--space-2);margin:0}.wb-section dt{color:var(--muted)}.wb-section dd{margin:0;overflow-wrap:anywhere}
.wb-inline-edit{margin:0;min-width:0}.wb-inline-edit summary{list-style:none;cursor:pointer;min-height:var(--row-h)}.wb-inline-edit summary::-webkit-details-marker{display:none}.wb-pencil{margin-left:4px;opacity:1;font-size:var(--fs-sm);color:var(--muted)}.wb-inline-edit summary:hover .wb-pencil,.wb-inline-edit summary:focus-visible .wb-pencil{opacity:1}.wb-inline-edit[open]>summary{display:none}.wb-inline-edit form{margin:0}.wb-inline-edit label{font-size:0}.wb-inline-edit label input,.wb-inline-edit label select,.wb-inline-edit label textarea{width:100%;font-size:var(--fs-md)}.wb-inline-edit button{font-size:var(--fs-sm)}
.wb-form-row{display:grid;grid-template-columns:minmax(0,1fr);max-width:46rem;gap:var(--space-2);align-items:start;margin-bottom:var(--space-2)}
.wb-form-row>label{padding-top:var(--space-1)}.wb-hint{font-size:var(--fs-sm);color:var(--muted);margin:var(--space-1) 0}
.wb-empty{padding:var(--space-4) var(--space-2);border-bottom:var(--separator) solid var(--line)}.wb-empty h2{font-size:var(--fs-md);margin:0}.wb-empty p{color:var(--muted);margin:var(--space-2) 0}
@media(max-width:760px){.wb-form-row{grid-template-columns:1fr}.wb-tabs a,.wb-tree a,.wb-tree summary{min-height:var(--tap)}}
/* A single sidebar owns organization places and the project's resource tree. */
#rail>.explorer{position:static;transform:none;width:auto;box-shadow:none;border:0;border-top:1px solid var(--line);padding:8px 0;margin-top:8px}
#rail .explorer>.railhead{display:none}
#rail .wb-tree li{display:block}
#rail .wb-tree a{display:block;min-width:0;height:var(--row-h);padding:3px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:var(--fs-sm)}
#rail .wb-count{float:right;margin-left:8px;color:var(--muted)}
#rail .wb-tree summary{display:flex;align-items:center;padding:0;list-style:none;height:var(--row-h)}
#rail .wb-tree summary::-webkit-details-marker{display:none}
#rail .wb-tree summary a{flex:1;min-width:0}
.wb-chevron{width:16px;text-align:center;flex-shrink:0;cursor:pointer}details[open]>summary>.wb-chevron{transform:rotate(90deg)}
#rail .project-heading{display:block;padding:4px 8px;color:var(--ink);font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-decoration:none}
#rail .project-switcher li a{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:var(--fs-sm)}
#rail .project-endpoints{padding:4px;margin:4px 0}
#rail .project-endpoints>div{display:flex;align-items:center;height:var(--row-h);gap:4px}
#rail .project-endpoints a,#rail .project-endpoints code{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0;font-size:var(--fs-xs);background:none}
#rail .project-endpoints button{flex-shrink:0;padding:0 4px;margin:0;border:0;background:none;color:var(--muted)}
.wb-table .work-title{max-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%}.work-title a{white-space:nowrap}@media(max-width:760px){.wb-table .work-title{max-width:none;white-space:normal;width:auto}.work-title a{white-space:normal}}
#inspector .wb-actions{flex-wrap:nowrap;gap:4px;width:100%}#inspector .wb-actions button{font-size:var(--fs-xs);padding:3px 5px;white-space:nowrap}#inspector .wb-actions p{margin:0}
.bar .sidebar-toggle{display:none}@media(min-width:1280px){#rail>.railhead{display:flex;padding:4px 8px 8px;font-size:var(--fs-md)}body.wb.sidebar-collapsed{grid-template-columns:36px minmax(0,1fr)}body.sidebar-collapsed #rail{padding:0}body.sidebar-collapsed #rail>*{display:none}.bar .sidebar-toggle{display:inline-block}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:var(--fs)/1.45 var(--font);font-variant-numeric:tabular-nums}
a{color:var(--accent);text-underline-offset:2px}
:focus-visible{outline:var(--focus-width) solid var(--focus)!important;outline-offset:var(--focus-offset);border-radius:var(--r-xs)}
h1{font-size:var(--fs-h1);line-height:1.25;letter-spacing:-.01em;margin:2px 0 6px}h2{font-size:14px;margin:18px 0 6px}h3{font-size:13.5px;margin:2px 0}
.lede{color:var(--muted);max-width:46rem;margin:4px 0 10px}
.crumbs{color:var(--muted);font-size:var(--fs-sm);margin:0 0 2px}.crumbs a{color:var(--muted)}




.chips{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 8px}.chip{display:inline-block;padding:1px 8px;border-radius:var(--r-sm);background:var(--sunk);color:var(--ink);text-decoration:none;font-size:var(--fs-sm);border:1px solid transparent}
.chip[aria-current]{background:var(--ink);color:var(--panel)}.chips+.chips{margin-top:-4px}.chips .gap{width:8px}
form.filters{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 8px}form.filters label{margin:0;display:flex;flex-direction:column;align-items:flex-start}
.k-wish{color:var(--wish)}.k-snag{color:var(--snag)}.k-errand{color:var(--errand)}.k-quest{color:var(--quest)}.k-call{color:var(--call)}.k-spark{color:var(--spark)}
.kd{display:inline-block;width:8px;height:8px;border-radius:2px;background:currentColor;margin-right:6px;vertical-align:1px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
th,td{padding:4px 8px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:var(--fs-xs);color:var(--muted);font-weight:600;background:var(--sunk);position:sticky;top:0}
tr:last-child td{border-bottom:0}tr[data-href]{cursor:pointer}tr[data-href]:hover td{background:var(--sunk)}tr[aria-selected=true] td{background:var(--accent-soft)}
td[class^=k-]{white-space:nowrap}td.ref,td.when{white-space:nowrap;color:var(--muted);font-size:var(--fs-sm)}td a{color:var(--ink);text-decoration:none}td a:hover{text-decoration:underline}
.timeline{list-style:none;padding:0;margin:0}.timeline li{display:grid;grid-template-columns:7rem 1fr;gap:8px;padding:3px 0;border-bottom:1px solid var(--line);font-size:var(--fs-md)}
.timeline time{color:var(--muted);font-size:12px}#inspector .timeline li{grid-template-columns:3.2rem 1fr}
button,.button{font:inherit;font-size:var(--fs-md);font-weight:600;padding:3px 10px;border-radius:var(--r-sm);border:1px solid var(--ink);background:var(--ink);color:var(--panel);cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.button:hover{background:var(--accent);border-color:var(--accent)}button.quiet,.button.quiet{background:var(--panel);color:var(--ink);border-color:var(--line)}button.destructive,.button.destructive{color:var(--del)}
.wb-address{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;overflow-wrap:normal;font-family:var(--mono)}.wb-address code{white-space:nowrap}.wb-address button{padding:0 4px;min-height:24px;font-weight:400}
.pane form:not(.inline):not(.filters):not(.wb-comment):not(.composer):not(.docket-toolbar form){max-width:46rem}.pane form:not(.inline):not(.filters):not(.wb-comment):not(.composer) label:has(>input:not([type=hidden])):not(:has(input[type=checkbox])),.pane form:not(.inline):not(.filters) label:has(>textarea),.pane form:not(.inline):not(.filters) label:has(>select){display:block;margin:0 0 8px}.pane form:not(.inline):not(.filters) label>input:not([type=checkbox]),.pane form:not(.inline):not(.filters) label>textarea,.pane form:not(.inline):not(.filters) label>select{display:block;max-width:100%;margin-top:4px}
.voice-field{position:relative;display:block}.voice-field textarea{display:block;padding-right:44px!important}.voice-field>.mic{position:absolute;right:5px;bottom:5px}.voice-field>.voicestate{display:none}
.wb-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.wb-board-columns td:last-child{overflow-wrap:normal;word-break:normal}.wb-toolbar a,.wb-toolbar button{font-weight:500;white-space:nowrap}.wb-toolbar a:not(.wb-tabs a),.wb-toolbar button,.channel-header>.button.quiet,[data-presence-toggle],.wb-close{font-size:var(--fs);font-weight:500;padding:3px 8px;min-height:0;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--panel);color:var(--ink);text-decoration:none}.wb-toolbar button:hover,.button.quiet:hover,button.quiet:hover{background:var(--sunk);border-color:var(--line)}.channel-header>.button.quiet{font-weight:500}
.status-report .wb-table thead{display:none}
button:disabled{opacity:.5;cursor:not-allowed}
button.link{background:none;border:0;padding:3px 8px;color:var(--ink);font-weight:500;cursor:pointer}button.link:hover{background:none;color:var(--accent);text-decoration:underline}

input,select,textarea{font:inherit;font-size:var(--fs-md);padding:3px 7px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--panel);color:var(--ink);max-width:100%}
label{display:inline-block;margin:3px 8px 3px 0}
form.inline{display:inline}pre{white-space:pre-wrap;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:8px;font-size:var(--fs-sm)}
code,kbd{background:var(--sunk);padding:0 4px;border-radius:var(--r-xs);font-size:12px}
.prose{white-space:pre-wrap;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:8px 10px;max-width:46rem}
blockquote{margin:6px 0;padding:4px 10px;border-left:3px solid var(--accent);color:var(--muted);background:var(--sunk);border-radius:0 4px 4px 0}
details.edit{margin:8px 0;max-width:46rem}details.edit summary{cursor:pointer;font-weight:650;color:var(--accent)}details.edit label{display:block;margin:6px 0}
details.edit label>input,details.edit label>textarea{display:block;width:100%;margin-top:2px}details.edit label>select{display:block;margin-top:2px}details.edit .row{display:flex;flex-wrap:wrap;gap:0 12px}





.mic{flex:none;display:inline-grid;place-items:center;width:36px;height:36px;min-height:0;padding:0;border-radius:50%;background:var(--panel);color:var(--ink);border:1px solid var(--line);touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;--lvl:0}
.mic svg{width:20px;height:20px;fill:currentColor}.mic:hover{background:var(--accent-soft);color:var(--ink);border-color:var(--accent)}
.mic.live{background:var(--snag);border-color:var(--snag);color:#fff;box-shadow:0 0 0 calc(3px + var(--lvl) * 12px) color-mix(in srgb,var(--snag) 22%,transparent);transition:box-shadow .08s linear}
.voicebar{display:flex;align-items:center;gap:10px;margin:6px 0}.voicestate{font-size:var(--fs-sm);color:var(--muted)}.voicestate:empty{display:none}
.voicestate.live{color:var(--snag);font-weight:600}.voicestate.err{color:var(--snag)}.voicestate.ok{color:var(--accent)}.composer .voicestate{display:block;padding:6px 4px 0}
@media (max-width:760px){.mic{width:44px;height:44px}.mic svg{width:24px;height:24px}}
.intent{position:static;background:none;padding:8px 0 6px;max-width:46rem}
.intent .box{padding:12px 12px 12px 18px;border-radius:18px;border-width:1.5px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
.intent textarea{font-size:20px;line-height:1.5;min-height:4.5em;max-height:55vh;overflow-y:auto;padding:4px 0}
.intent textarea::placeholder{color:var(--faint)}
@media (max-width:760px){.intent textarea{font-size:19px;min-height:5em}.intent .box{padding:10px 10px 10px 14px}}
.intent-page{max-width:46rem}.intent-page .said{font-size:calc(var(--fs) + 1px);color:var(--muted);margin:4px 0 8px}.intent-page .small{font-size:var(--fs-sm);margin-top:18px}

.hits{margin:4px 0 8px;padding-left:20px}.hits li{margin:4px 0}.hits small{color:var(--muted)}div.hits{padding-left:0}
.intent-result .say{margin:0 0 8px;font-weight:600}.intent-result .say:last-child{margin:0}.intent-result label.f{display:block;margin:0 0 10px}.intent-result label.f>span{display:block;font-size:var(--fs-sm);color:var(--muted);margin-bottom:2px}
.intent-result label.f input,.intent-result label.f textarea,.intent-result label.f select{display:block;width:100%}.intent-result .row{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
@media (max-width:760px){.intent-result .row{grid-template-columns:1fr}}
.extra-check{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:var(--r);padding:12px 16px;margin:10px 0;max-width:40rem}
.extra-check h2{margin:0 0 4px}.extra-check p{margin:4px 0 10px}.extra-check .actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.extra-check .sent{color:var(--ink);background:var(--accent-soft);padding:8px 10px;border-radius:var(--r-sm)}
button.copy{min-width:6rem}
.channel-content{min-width:0;overflow-wrap:anywhere}.channel-header{padding:0 0 12px;border-bottom:1px solid var(--line)}.channel-header .inline{display:inline-block;margin-top:6px}
.channel-message{padding:var(--space-2) 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.channel-message p{margin:0 0 4px}.channel-message pre{font:inherit;overflow-wrap:anywhere;border:0;background:none;padding:0}
.unread-divider{font-size:var(--fs-sm);color:var(--accent);border-top:2px solid var(--accent);padding-top:8px;scroll-margin-top:16px}.thread-root{background:var(--sunk);padding:12px;border:1px solid var(--line);border-radius:var(--r);margin-top:12px}.thread-root h2{font-size:var(--fs-sm);margin:0}.channel-message:target{background:var(--accent-soft);scroll-margin-top:16px}
.channel-compose{margin-top:16px;padding:12px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r)}.channel-compose label,.channel-compose textarea{display:block;width:100%}.channel-compose textarea{resize:vertical;margin-bottom:8px}

.only-s{display:none}
.panes:has(#inspector .assist){grid-template-columns:minmax(200px,.35fr) 4px minmax(0,1fr)}
@media(max-width:760px){.panes:has(#inspector .assist){grid-template-columns:minmax(0,1fr)}}
.channel-content pre,.mail-message-text{min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}.channel-compose textarea{width:100%;min-width:0}
.assist{display:flex;flex-direction:column;min-height:100%;max-width:48rem;margin:0 auto;font-size:var(--fs-chat);line-height:1.55}
.assist-top{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.assist-top .chips{margin:0}
.chatlog{flex:1;display:flex;flex-direction:column;gap:18px;padding:16px 0 20px}
.welcome{margin:auto 0;padding:24px 0;text-align:center}.welcome h1{font-size:calc(var(--fs-h1) + 4px);margin:14px 0 6px}.welcome .lede{margin:0 auto 22px;max-width:34rem}
.who{flex:none;width:30px;height:30px;border-radius:50%;background:var(--accent);color:var(--panel);display:grid;place-items:center;font-weight:800;font-size:14px}
.who.big{width:48px;height:48px;font-size:22px;margin:0 auto}
.starters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;text-align:left}
.starter{display:flex;flex-direction:column;gap:2px;min-height:64px;padding:12px 14px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:var(--r);font-weight:500;font-size:var(--fs-chat);text-align:left}
.starter b{font-size:var(--fs-sm);color:var(--accent);font-weight:700}.starter:hover{background:var(--accent-soft);border-color:var(--accent);color:var(--ink)}
.msg{display:flex;gap:10px;align-items:flex-start}.msg .body{min-width:0;max-width:100%}.msg .body p{margin:0 0 8px}.msg .body p:last-child{margin-bottom:0}.msg .body ul{margin:4px 0 8px;padding-left:22px}
.msg.user{justify-content:flex-end}.msg.user .body{max-width:85%;background:var(--accent-soft);padding:10px 14px;border-radius:18px 18px 4px 18px;white-space:pre-wrap}
.msg.assistant .body{flex:1;padding-top:3px}
.thinking{color:var(--muted);display:flex;align-items:center;gap:4px}.thinking i{width:7px;height:7px;border-radius:50%;background:var(--accent);animation:dot 1.2s infinite ease-in-out}
.thinking i:nth-child(2){animation-delay:.15s}.thinking i:nth-child(3){animation-delay:.3s;margin-right:6px}
@keyframes dot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
@media (prefers-reduced-motion:reduce){.thinking i{animation:none;opacity:.6}}
.err{color:var(--snag);font-weight:600}
.steps{margin-top:8px;font-size:var(--fs-sm)}.steps summary{cursor:pointer;color:var(--muted);display:inline-block;padding:2px 10px;border:1px solid var(--line);border-radius:999px}.steps li{margin:6px 0}
.composer{position:sticky;bottom:0;background:linear-gradient(transparent,var(--bg) 18px);padding:18px 0 6px}
.composer .box{display:flex;align-items:flex-end;gap:8px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:8px 8px 8px 14px;box-shadow:var(--shadow)}
.composer .box:focus-within{border-color:var(--accent)}
.composer textarea{flex:1;border:0;background:none;resize:none;padding:6px 0;font-size:var(--fs-chat);line-height:1.5;min-height:0;max-height:40vh;outline:none}
.composer .send{flex:none;width:40px;height:40px;min-height:0;padding:0;border-radius:50%;font-size:20px;line-height:1;background:var(--accent);border-color:var(--accent)}
.composer .mode{display:flex;flex-wrap:wrap;gap:4px 18px;padding:8px 4px 0;color:var(--muted);font-size:var(--fs-sm)}.composer .mode label{display:inline-flex;align-items:center;gap:6px;margin:0;cursor:pointer}
.composer .mode input{min-height:0;width:18px;height:18px;accent-color:var(--accent)}
@media (max-width:760px){.only-s{display:inline-block}.starters{grid-template-columns:1fr}.composer .send{width:44px;height:44px}.welcome{padding:8px 0}}
.add{color:var(--add)}.del{color:var(--del)}
.bulk{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0;font-size:var(--fs-md)}
.pill{display:inline-block;font-size:10.5px;font-weight:650;padding:0 5px;border-radius:var(--r-xs);background:var(--sunk);color:var(--muted);border:1px solid var(--line);vertical-align:1px;margin-left:4px}
.planned{border:1px dashed var(--line);border-radius:var(--r);padding:6px 10px;margin:8px 0;color:var(--muted);font-size:var(--fs-md)}.planned b{color:var(--ink)}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;font-size:var(--fs-md);margin:6px 0}.meta dt{color:var(--muted)}.meta dd{margin:0}
.head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:var(--fs-sm)}
.empty{color:var(--muted);padding:24px 8px;text-align:center}
.plain{background:var(--bg)}.plain main{max-width:40rem;margin:0 auto;padding:40px 16px}.plain .top{padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
.plain .brand,.bar .brand{font-weight:800;color:var(--ink);text-decoration:none}.plain footer{max-width:40rem;margin:0 auto;padding:16px;color:var(--muted);font-size:var(--fs-sm)}
body.wb{height:100vh;height:100dvh;display:grid;grid-template-columns:var(--rail-w) minmax(0,1fr);grid-template-rows:var(--bar-h) minmax(0,1fr) var(--status-h);grid-template-areas:"bar bar" "rail main" "status status";overflow:hidden}
#wb-navigation,#wb-ambiguous{position:fixed;top:calc(var(--bar-h) + 8px);left:12px;right:12px;z-index:40;margin:0 auto;padding:12px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}
.bar{grid-area:bar;display:flex;align-items:center;gap:10px;padding:0 10px;background:var(--panel);border-bottom:1px solid var(--line);min-width:0}
.bar .org{color:var(--muted);text-decoration:none;font-weight:600;white-space:nowrap}.bar .org:before{content:"/";margin-right:8px;color:var(--line)}
.bar .menu{display:none;text-decoration:none;color:var(--ink);font-size:18px}.bar .me{color:var(--muted);text-decoration:none;font-size:var(--fs-sm);white-space:nowrap;margin-left:auto}.bar .inline button{font-size:var(--fs-sm);font-weight:500;white-space:nowrap}
.jump{position:relative;flex:0 0 32%;max-width:520px;margin:0}.jump input{width:100%;padding:4px 8px 4px 8px;background:var(--sunk)}
.jump kbd{position:absolute;right:6px;top:5px;color:var(--faint)}
.jump ul{position:absolute;left:0;right:0;top:30px;margin:0;padding:4px;list-style:none;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);z-index:30}
.jump li a{display:flex;justify-content:space-between;gap:8px;padding:4px 8px;border-radius:var(--r-sm);color:var(--ink);text-decoration:none}.jump li a small{color:var(--muted)}
.jump li[aria-selected=true] a,.jump li a:hover{background:var(--accent-soft)}
.jump ul{max-height:min(70vh,520px);overflow:auto;overscroll-behavior:contain}.jump li.group{padding:8px 8px 2px;font-size:var(--fs-xs);font-weight:650;color:var(--faint)}.jump li.group:first-child{padding-top:2px}
.rail{grid-area:rail;overflow:auto;background:var(--sunk);border-right:1px solid var(--line);padding:8px 6px 16px;font-size:var(--fs-md)}
.rail ul{list-style:none;margin:0 0 6px;padding:0}.rail li{display:flex;align-items:center;border-radius:var(--r-sm)}.rail li[hidden]{display:none}
.rail li a{flex:1;padding:3px 8px;color:var(--ink);text-decoration:none;border-radius:var(--r-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rail li.account-details{display:block;padding:3px 8px;color:var(--muted);font-size:var(--fs-sm);overflow-wrap:anywhere}.account-details span{display:block}
.rail li:hover{background:var(--line)}.rail li a[aria-current]{font-weight:700}.rail li:has(a[aria-current]){background:var(--panel);box-shadow:inset 2px 0 0 var(--accent)}
.rail .n{color:var(--muted);font-size:12px;padding-right:8px}.rail .wb-count{float:right}.rail h4{margin:10px 8px 2px;font-size:11px;color:var(--faint);font-weight:650;letter-spacing:.02em}
.rail .close,.explorer .close{display:none}
.explorer{min-width:0;background:var(--sunk);border-right:1px solid var(--line);padding:8px;font-size:var(--fs-md)}
.explorer h2{font-size:var(--fs-sm);margin:12px 0 4px}.explorer label{font-weight:650}.explorer input{width:100%;margin:4px 0}.explorer .wb-tree a,.explorer .wb-tree summary{min-height:var(--row-h);padding:4px}.explorer .wb-tree ul{padding-left:12px}.explorer .wb-tree>ul{padding-left:0}
.project-switcher ul{list-style:none;margin:4px 0;padding:0;max-height:220px;overflow:auto}.project-switcher li a{display:block;padding:4px;color:var(--ink);text-decoration:none}.project-switcher li a[aria-current],.project-switcher li a:hover{background:var(--accent-soft)}.project-switcher small{display:block;color:var(--muted)}.project-switcher summary{padding:4px;font-weight:650}.project-overview{display:block;padding:8px 4px}.project-endpoints{border-top:1px solid var(--line);margin-top:8px;padding:0 4px}.project-endpoints a,.project-endpoints code{display:block;overflow-wrap:anywhere;font-size:var(--fs-sm)}.project-endpoints button{margin-top:4px}
.bar>.wb-breadcrumb{min-width:0;flex:0 0 32%;max-width:32%;overflow:auto;white-space:nowrap}.bar .wb-breadcrumb ol{flex-wrap:nowrap;margin:0}.bar .wb-breadcrumb li{flex-shrink:0}.bar .wb-breadcrumb a{white-space:nowrap}.explorer-toggle{display:none}
.panes{grid-area:main;display:grid;grid-template-columns:minmax(0,1fr) 6px minmax(0,var(--inspector-width,390px));min-height:0}
.wb-resizer{cursor:col-resize;background:var(--line);touch-action:none}.wb-resizer:hover,.wb-resizer:focus{background:var(--accent)}.panes.one .wb-resizer{display:none}.wb-close{float:right;margin:0 0 6px 8px}
#bulk{display:none}#list:has(input[form=bulk]:checked) #bulk{display:flex}
.docket-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.docket-toolbar .wb-tabs{margin:0;gap:0}.docket-toolbar .filters{margin:0;gap:6px}.docket-toolbar .wb-tabs a{padding:4px 6px}.docket-toolbar select{max-width:105px}.docket-toolbar input[data-filter]{width:140px;min-width:0}
.panes.one{grid-template-columns:minmax(0,1fr)}.panes.one #inspector{display:none}
.pane{overflow:auto;min-height:0;padding:10px 14px 24px}.panes:not(.one) #list{border-right:1px solid var(--line)}#inspector{background:var(--panel)}
.pane .back{display:none}
.status{grid-area:status;display:flex;align-items:center;gap:14px;padding:0 10px;border-top:1px solid var(--line);background:var(--panel);font-size:var(--fs-xs);color:var(--muted);white-space:nowrap;overflow:hidden}
.status a{color:var(--muted);flex-shrink:0}.status .keys{margin-left:auto;flex-shrink:0}#connection-state{min-width:0;overflow:hidden;text-overflow:ellipsis}#connection-state p{margin:0;display:inline}#perf{flex-shrink:0}
.tabs{display:none}
/* Narrow screens: the rail becomes a drawer over the page, with a backdrop. */
.railhead{display:none}.scrim{display:none}.bar .ml{display:none}
@media (max-width:1279px){body.wb{grid-template-columns:minmax(0,1fr);grid-template-areas:"bar" "main" "status"}
.rail,.explorer{position:fixed;top:0;bottom:0;left:0;width:min(86vw,340px);z-index:40;transform:translateX(-102%);transition:transform .2s ease;box-shadow:var(--shadow);padding:calc(8px + env(safe-area-inset-top)) 8px calc(16px + env(safe-area-inset-bottom)) calc(8px + env(safe-area-inset-left));overscroll-behavior:contain}
.rail:target,.rail.open,.explorer:target,.explorer.open{transform:none}
.railhead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 4px 10px 8px;border-bottom:1px solid var(--line);margin-bottom:8px}
.railhead b{font-size:calc(var(--fs) + 2px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rail .close,.explorer .close{display:inline-flex;align-items:center;min-height:var(--tap);padding:0 12px;border-radius:var(--r-sm);background:var(--panel);border:1px solid var(--line);color:var(--ink);text-decoration:none;font-weight:600;white-space:nowrap}
.scrim{position:fixed;inset:0;z-index:35;background:rgba(10,14,20,.45)}
.rail:target~.scrim,.rail.open~.scrim,.explorer:target~.scrim,.explorer.open~.scrim{display:block}
.explorer-toggle{display:inline-flex;align-items:center;min-height:var(--tap);color:var(--ink);text-decoration:none;font-weight:650}
.bar .menu{display:inline-flex;align-items:center;gap:6px;min-height:var(--tap);padding:0 10px;margin-left:-6px;border-radius:var(--r-sm);font-weight:650}
.bar .menu span[aria-hidden]{font-size:22px;line-height:1}.bar .ml{display:inline}}
@media (max-width:760px){
body.wb{grid-template-rows:auto minmax(0,1fr) auto;grid-template-areas:"bar" "main" "tabs"}
.bar{min-height:calc(var(--bar-h) + env(safe-area-inset-top));padding:env(safe-area-inset-top) calc(8px + env(safe-area-inset-right)) 0 calc(8px + env(safe-area-inset-left));gap:8px}
.bar .ml{display:inline}.bar{flex-wrap:wrap;padding-bottom:4px}.bar>.wb-breadcrumb{order:5;flex-basis:100%;max-width:100%;font-size:var(--fs-sm)}.bar>.wb-breadcrumb a{min-height:24px}.bar .jump{min-width:0;flex:1}.bar .jump input{min-width:0}.bar .file{white-space:nowrap}
.status{display:none}.bar .org,.bar .me,.bar .header-copy,.jump kbd{display:none}
.jump input{min-height:var(--tap);font-size:16px;padding:6px 12px;border-radius:var(--r)}.jump ul{top:calc(var(--tap) + 4px)}.jump li a{padding:12px}
.bar .file{min-height:var(--tap);display:inline-flex;align-items:center;padding:0 14px}
button,.button{min-height:var(--tap);padding:6px 16px;font-size:var(--fs-md)}button.link{min-height:var(--tap)}
input,select,textarea{font-size:16px;min-height:var(--tap);padding:8px 10px}
.rail{font-size:18px}.rail li a{padding:0 12px;min-height:50px;display:flex;align-items:center}.rail .n{font-size:15px;font-weight:600;padding-right:12px}
.rail h4{font-size:14px;margin:16px 12px 4px}
.panes{grid-template-columns:minmax(0,1fr)}.wb-resizer{display:none}body[data-focus=inspector] #list{display:none}body[data-focus=list] #inspector{display:none}
.panes:not(.one) #list{border-right:0}.pane{padding:12px 14px 28px}
body .panes.wb-stacked:not(.one){grid-template-rows:minmax(0,2fr) minmax(0,3fr)}body .panes.wb-stacked:not(.one) #list,body .panes.wb-stacked:not(.one) #inspector{display:block}body .panes.wb-stacked:not(.one) #list{border-bottom:var(--separator) solid var(--line)}
.pane .back{display:inline-flex;align-items:center;min-height:var(--tap);font-size:var(--fs);font-weight:600;margin-bottom:6px;text-decoration:none}
th,td{padding:12px 10px}th{font-size:14px}td.ref,td.when{font-size:15px}
.chip{padding:8px 14px;font-size:15px}.chips{gap:8px}
h2{font-size:19px;margin:24px 0 8px}h3{font-size:17px}
code,kbd{font-size:15px}.pill{font-size:13px;padding:1px 7px}.meta{font-size:var(--fs);gap:6px 14px}
.tabs{grid-area:tabs;display:flex;border-top:1px solid var(--line);background:var(--panel);padding-bottom:env(safe-area-inset-bottom)}
.tabs a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:64px;font-size:15px;font-weight:600;color:var(--muted);text-decoration:none}
.tabs a[aria-current]{color:var(--accent);box-shadow:inset 0 3px 0 var(--accent)}.tabs .n{font-size:13px;min-width:22px;padding:0 6px;border-radius:11px;background:var(--accent);color:var(--panel);text-align:center;line-height:20px}
.hide-s{display:none}.timeline li{grid-template-columns:1fr;gap:0;padding:8px 0}.timeline time{font-size:14px}}
/* Tactile treatments deliberately change no geometry: the same rows fit on screen. */
.rail{background:var(--rail)}.pane{background:var(--panel);box-shadow:inset 0 0 0 1px var(--line),var(--elevation-1)}
.bar{background:linear-gradient(110deg,var(--selected),var(--group));box-shadow:var(--bevel),var(--elevation-1)}.status{background:var(--group);box-shadow:var(--bevel)}
.pane h2,.pane h3,.explorer h2,.railhead{color:var(--blue);font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.08em}
table{box-shadow:var(--elevation-1)}th{background:var(--group)}
button,.button{background:var(--secondary-gradient);color:var(--ink);border-color:var(--line-strong);box-shadow:var(--bevel),var(--elevation-1)}
button.primary,.button.primary,.wb-toolbar button.primary,.wb-toolbar .wb-actions a.primary,:where(form[method=post]) button:not(:where([type=button],.quiet,.link,.destructive)),.composer .send,.landing-create>summary{background:var(--primary-gradient);color:var(--on-primary);border-color:var(--primary-bottom);box-shadow:var(--bevel),var(--elevation-2)}
button:hover,.button:hover{background:var(--hover);color:var(--ink);border-color:var(--accent);box-shadow:var(--elevation-2)}
button.primary:hover,.button.primary:hover,.wb-toolbar button.primary:hover,.wb-toolbar .wb-actions a.primary:hover,:where(form[method=post]) button:not(:where([type=button],.quiet,.link,.destructive)):hover,.composer .send:hover{background:var(--primary-hover);color:var(--on-primary);border-color:var(--primary-bottom);box-shadow:var(--elevation-2)}
button.quiet,.button.quiet,.wb-toolbar a:not(.wb-tabs a):not(.primary),.wb-toolbar button,.wb-close{background:var(--secondary-gradient);color:var(--ink);border-color:var(--line-strong);box-shadow:var(--bevel),var(--elevation-1)}
button.quiet:hover,.button.quiet:hover,.wb-toolbar a:not(.wb-tabs a):not(.primary):hover,.wb-toolbar button:hover,.wb-close:hover{background:var(--hover);border-color:var(--accent)}
button.link{color:var(--accent);text-decoration:underline;background:none;box-shadow:none}
button.link:hover{background:var(--hover);color:var(--accent)}
button:active,.button:active,button.quiet:active,.button.quiet:active,button.link:active,.wb-toolbar button:active,.wb-toolbar a:active,.wb-toolbar .wb-actions a.primary:active{background:var(--selected);color:var(--ink);box-shadow:var(--inset)}
button:disabled,button:disabled:hover,button:disabled:active,.wb-toolbar button:disabled,.button[aria-disabled=true],.button[aria-disabled=true]:hover,.button[aria-disabled=true]:active{opacity:1;background:var(--group);color:var(--muted);border-color:var(--line);box-shadow:none;cursor:not-allowed}
button.destructive,.button.destructive{color:var(--error)}
input,select,textarea,.jump input{background:var(--field);border-color:var(--line-strong);box-shadow:var(--inset)}
input:focus,select:focus,textarea:focus{border-color:var(--focus)}
input:disabled,select:disabled,textarea:disabled{background:var(--group);color:var(--muted);box-shadow:none}
input::placeholder,textarea::placeholder{color:var(--faint);opacity:1}
input[type=checkbox],input[type=radio]{accent-color:var(--accent)}
td a,.wb-breadcrumb a{color:var(--accent);text-decoration:underline;text-decoration-thickness:1px}
tr[data-href] td:first-child{box-shadow:inset 2px 0 var(--blue)}
tr[data-href]:hover td,.wb-table tr[data-href]:hover{background:var(--hover)}
tr[aria-selected=true] td,.wb-table tr[aria-selected=true]{background:var(--selected-gradient)}
tr[aria-selected=true] td:first-child{box-shadow:inset 3px 0 var(--accent)}
.wb-tree a:hover,.wb-tree summary:hover,.rail li:hover{background:var(--hover)}
.rail li:has(a[aria-current]){background:transparent;box-shadow:none}
.wb-tree a[aria-current],.rail li>a[aria-current],.wb-tabs a[aria-current],.tabs a[aria-current]{background:var(--selected);color:var(--accent);box-shadow:inset 3px 0 var(--accent);border-radius:0;font-weight:700}
.wb-chevron{color:var(--blue);background:var(--group);border-radius:var(--r-xs)}
.wb-tree ul ul{border-color:var(--line-strong)}
.wb-chip{background:var(--group);box-shadow:var(--bevel)}
.wb-state{background:none;box-shadow:none}
.landing-create>summary{display:inline-block;border:1px solid var(--primary-bottom);border-radius:var(--r-sm);padding:3px 10px;cursor:pointer;font-weight:600}
.landing-create>summary:hover{background:var(--primary-hover)}
button.primary:active,.button.primary:active,.wb-toolbar button.primary:active,.composer .send:active{background:var(--selected);color:var(--ink);box-shadow:var(--inset)}
button.primary:disabled,.wb-toolbar button.primary:disabled,.composer .send:disabled{background:var(--group);color:var(--muted);box-shadow:none}
td a{text-decoration-color:color-mix(in srgb,currentColor 40%,transparent)}td a:hover{text-decoration-color:currentColor}
:is(.k-wish,.k-snag,.k-errand,.k-quest,.k-call,.k-spark,.wb-tone-wish,.wb-tone-snag,.wb-tone-errand,.wb-tone-quest,.wb-tone-call,.wb-tone-spark){background:color-mix(in srgb,currentColor 12%,var(--panel))}
.composer{background:none}.composer textarea{background:none;box-shadow:none}
.wb-tone-attention{color:var(--attention)}.wb-tone-progress{color:var(--progress)}.wb-tone-success{color:var(--success)}.wb-tone-warning{color:var(--warning)}.wb-tone-error{color:var(--error)}
.tabs .n{background:var(--primary-bottom);color:var(--on-primary)}
@media (prefers-reduced-motion:reduce){.rail,.explorer{transition:none}}
`;
