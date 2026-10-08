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
.bars{display:flex;align-items:flex-end;gap:2px;height:64px;margin:4px 0 12px}.bars div{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;min-width:0}.bars span{display:block;width:100%;background:var(--accent);border-radius:var(--r-xs) var(--r-xs) 0 0}.bars small{font-size:9px;color:var(--faint)}
.onramp{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:10px;margin:10px 0 18px;max-width:46rem}
.onramp a{display:flex;flex-direction:column;justify-content:center;gap:2px;min-height:64px;padding:12px 16px;border-radius:var(--r);background:var(--accent);border:1px solid var(--accent);color:var(--panel);text-decoration:none}
.onramp a:hover{filter:brightness(1.08)}.onramp b{font-size:calc(var(--fs) + 2px)}.onramp b:before{content:"+ ";font-weight:800}.onramp span{font-size:var(--fs-sm);opacity:.92}
.mic{flex:none;display:inline-grid;place-items:center;width:36px;height:36px;min-height:0;padding:0;border-radius:50%;background:var(--panel);color:var(--ink);border:1px solid var(--line);touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;--lvl:0}
.mic svg{width:20px;height:20px;fill:currentColor}.mic:hover{background:var(--accent-soft);color:var(--ink);border-color:var(--accent)}
.mic.live{background:var(--snag);border-color:var(--snag);color:#fff;box-shadow:0 0 0 calc(3px + var(--lvl) * 12px) color-mix(in srgb,var(--snag) 22%,transparent);transition:box-shadow .08s linear}
.voicebar{display:flex;align-items:center;gap:10px;margin:6px 0}.voicestate{font-size:var(--fs-sm);color:var(--muted)}.voicestate:empty{display:none}
.voicestate.live{color:var(--snag);font-weight:600}.voicestate.err{color:var(--snag)}.voicestate.ok{color:var(--accent)}.composer .voicestate{display:block;padding:6px 4px 0}
@media (max-width:760px){.mic{width:44px;height:44px}.mic svg{width:24px;height:24px}}
.only-s{display:none}
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
table.diff{font-family:var(--mono);font-size:12px;margin:4px 0 14px}table.diff td{padding:0 6px;border:0;white-space:pre-wrap;word-break:break-all}table.diff code{background:none;padding:0;font-size:12px;font-family:var(--mono)}
table.diff td.ln{color:var(--faint);text-align:right;width:1%;white-space:nowrap;user-select:none}table.diff tr.ins td{background:var(--add-bg)}table.diff tr.dl td{background:var(--del-bg)}
table.diff tr.hunk td{color:var(--muted);background:var(--sunk)}.add{color:var(--add)}.del{color:var(--del)}
.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:8px}.bcol{background:var(--sunk);border-radius:var(--r);padding:6px 8px}.bcol h2{margin:4px 0 8px}
.bcard{margin:0 0 6px;font-size:var(--fs-md)}.progress{height:6px;background:var(--sunk);border-radius:3px;overflow:hidden;margin:6px 0}.progress span{display:block;height:100%;background:var(--accent)}
.bulk{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0;font-size:var(--fs-md)}
@media (max-width:760px){.board{grid-template-columns:1fr}}
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
.jump ul{max-height:min(70vh,520px);overflow:auto;overscroll-behavior:contain}.jump li.group{padding:8px 8px 2px;font-size:var(--fs-xs);font-weight:650;color:var(--faint)}.jump li.group:first-child{padding-top:2px}
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
/* Narrow screens: the rail becomes a drawer over the page, with a backdrop. */
.railhead{display:none}.scrim{display:none}.bar .ml{display:none}
@media (max-width:1100px){body.wb{grid-template-columns:minmax(0,1fr);grid-template-areas:"bar" "main" "status"}
.rail{position:fixed;top:0;bottom:0;left:0;width:min(86vw,340px);z-index:40;transform:translateX(-102%);transition:transform .2s ease;box-shadow:var(--shadow);padding:calc(8px + env(safe-area-inset-top)) 8px calc(16px + env(safe-area-inset-bottom)) calc(8px + env(safe-area-inset-left));overscroll-behavior:contain}
.rail:target,.rail.open{transform:none}
.railhead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 4px 10px 8px;border-bottom:1px solid var(--line);margin-bottom:8px}
.railhead b{font-size:calc(var(--fs) + 2px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rail .close{display:inline-flex;align-items:center;min-height:var(--tap);padding:0 12px;border-radius:var(--r-sm);background:var(--panel);border:1px solid var(--line);color:var(--ink);text-decoration:none;font-weight:600;white-space:nowrap}
.scrim{position:fixed;inset:0;z-index:35;background:rgba(10,14,20,.45)}
.rail:target~.scrim,.rail.open~.scrim{display:block}
.bar .menu{display:inline-flex;align-items:center;gap:6px;min-height:var(--tap);padding:0 10px;margin-left:-6px;border-radius:var(--r-sm);font-weight:650}
.bar .menu span[aria-hidden]{font-size:22px;line-height:1}}
@media (max-width:760px){
body.wb{grid-template-rows:auto minmax(0,1fr) auto;grid-template-areas:"bar" "main" "tabs"}
.bar{min-height:calc(var(--bar-h) + env(safe-area-inset-top));padding:env(safe-area-inset-top) calc(8px + env(safe-area-inset-right)) 0 calc(8px + env(safe-area-inset-left));gap:8px}
.bar .ml{display:inline}.bar:has(.org) .brand{display:none}
.status{display:none}.bar .org,.bar .me,.jump kbd{display:none}
.jump input{min-height:var(--tap);font-size:16px;padding:6px 12px;border-radius:var(--r)}.jump ul{top:calc(var(--tap) + 4px)}.jump li a{padding:12px}
.bar .file{min-height:var(--tap);display:inline-flex;align-items:center;padding:0 14px}
button,.button{min-height:var(--tap);padding:6px 16px;font-size:var(--fs-md)}button.link{min-height:var(--tap)}
input,select,textarea{font-size:16px;min-height:var(--tap);padding:8px 10px}
.rail{font-size:18px}.rail li a{padding:0 12px;min-height:50px;display:flex;align-items:center}.rail .n{font-size:15px;font-weight:600;padding-right:12px}
.rail h4{font-size:14px;margin:16px 12px 4px}
.panes{grid-template-columns:minmax(0,1fr)}body[data-focus=inspector] #list{display:none}body[data-focus=list] #inspector{display:none}
.panes:not(.one) #list{border-right:0}.pane{padding:12px 14px 28px}
.pane .back{display:inline-flex;align-items:center;min-height:var(--tap);font-size:var(--fs);font-weight:600;margin-bottom:6px;text-decoration:none}
th,td{padding:12px 10px}th{font-size:14px}td.ref,td.when{font-size:15px}
.chip{padding:8px 14px;font-size:15px}.chips{gap:8px}
.card{padding:14px 16px}.card p{font-size:var(--fs)}h2{font-size:19px;margin:24px 0 8px}h3{font-size:17px}
code,kbd{font-size:15px}.pill{font-size:13px;padding:1px 7px}.meta{font-size:var(--fs);gap:6px 14px}
.tabs{grid-area:tabs;display:flex;border-top:1px solid var(--line);background:var(--panel);padding-bottom:env(safe-area-inset-bottom)}
.tabs a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:64px;font-size:15px;font-weight:600;color:var(--muted);text-decoration:none}
.tabs a[aria-current]{color:var(--accent);box-shadow:inset 0 3px 0 var(--accent)}.tabs .n{font-size:13px;min-width:22px;padding:0 6px;border-radius:11px;background:var(--accent);color:var(--panel);text-align:center;line-height:20px}
.hide-s{display:none}.timeline li{grid-template-columns:1fr;gap:0;padding:8px 0}.timeline time{font-size:14px}}
@media (prefers-reduced-motion:reduce){.rail{transition:none}}
`;
