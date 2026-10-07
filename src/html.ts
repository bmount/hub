const MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => MAP[ch]!);
}

/** The signed-in frame: header with organization and primary navigation, a footer with one reminder. */
export type Shell = { brandHref: string; org: { name: string; href: string } | null; nav: Array<{ href: string; label: string; active: boolean }>; me: { name: string; href: string }; tip: string };

// One design system for every page: light by default, dark when the system asks, system fonts only (no external
// requests), no scripts. Performance budget: this CSS stays under 4 KB.
const CSS = `
:root{--ink:#1f2a44;--muted:#5b6782;--paper:#fbf8f2;--card:#fff;--line:#e8e1d3;--soft:#f3efe6;--teal:#0f9e8c;--violet:#6c5ce7;--coral:#e8574b;--gold:#c99a12;--focus:#6c5ce7}
@media (prefers-color-scheme:dark){:root{--ink:#e9ecf5;--muted:#a9b1c7;--paper:#121726;--card:#1a2033;--line:#2b3350;--soft:#20283f;--teal:#3fc7b4;--violet:#a99bff;--coral:#ff8a7e;--gold:#e6c35a;--focus:#a99bff}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--violet);text-underline-offset:2px}a:hover{color:var(--teal)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:4px}
.top{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:.4rem 1rem;padding:.6rem clamp(12px,3vw,32px);background:color-mix(in srgb,var(--paper) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.brand{font-weight:800;font-size:1.15rem;color:var(--ink);text-decoration:none;letter-spacing:-.01em}
.org{color:var(--muted);text-decoration:none;font-weight:600}.org:before{content:"/";margin-right:.6rem;color:var(--line)}
.top nav{display:flex;flex-wrap:wrap;gap:.25rem;flex:1}
.top nav a{padding:.3rem .65rem;border-radius:999px;color:var(--ink);text-decoration:none;font-weight:550;font-size:.95rem}
.top nav a:hover{background:var(--soft)}.top nav a[aria-current]{background:var(--ink);color:var(--paper)}
.me{color:var(--muted);text-decoration:none;font-size:.92rem}
main{max-width:64rem;margin:0 auto;padding:1.4rem clamp(12px,3vw,32px) 3rem}
.plain main{max-width:40rem;padding-top:3rem}
h1{font-size:clamp(1.6rem,3.6vw,2.2rem);line-height:1.15;letter-spacing:-.02em;margin:.2rem 0 .6rem}
h2{font-size:1.15rem;margin:1.8rem 0 .6rem}h3{font-size:1rem;margin:.2rem 0}
.lede{color:var(--muted);font-size:1.05rem;max-width:42rem}
.crumbs{color:var(--muted);font-size:.9rem;margin:0}.crumbs a{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.9rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1rem 1.1rem}
.card h3 a{color:var(--ink);text-decoration:none}.card p{margin:.3rem 0;color:var(--muted);font-size:.93rem}
.stat{font-size:1.6rem;font-weight:750}.stat small{font-size:.85rem;color:var(--muted);font-weight:500;margin-left:.3rem}
.chips{display:flex;flex-wrap:wrap;gap:.4rem;margin:.4rem 0 1rem}.chip{display:inline-block;padding:.15rem .6rem;border-radius:999px;background:var(--soft);color:var(--ink);text-decoration:none;font-size:.88rem}
.chip[aria-current]{background:var(--ink);color:var(--paper)}.chips+.chips{margin-top:-.5rem}
form.filters{margin:0 0 1rem}form.filters label{margin-right:.6rem}
details.edit{margin:1rem 0;max-width:44rem}details.edit label{display:block;margin:.5rem 0}details.edit label>input,details.edit label>textarea{display:block;width:100%;margin-top:.2rem}details.edit label>select{display:block;margin-top:.2rem}details.edit .row{display:flex;flex-wrap:wrap;gap:0 1.2rem}.chips .gap{width:.8rem}details.edit summary{cursor:pointer;font-weight:650;color:var(--teal)}details.edit[open] summary{margin-bottom:.4rem}
.k-wish{color:var(--violet)}.k-snag{color:var(--coral)}.k-errand{color:var(--teal)}.k-quest{color:var(--gold)}.k-call{color:var(--ink)}.k-spark{color:var(--gold)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:.94rem}
th,td{padding:.5rem .7rem;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:.8rem;color:var(--muted);font-weight:600;background:var(--soft)}
tr:last-child td{border-bottom:0}
.timeline{list-style:none;padding:0;margin:0}.timeline li{display:grid;grid-template-columns:7.5rem 1fr;gap:.8rem;padding:.45rem 0;border-bottom:1px dashed var(--line)}
.timeline time{color:var(--muted);font-size:.85rem}
button,.button{font:inherit;font-weight:600;padding:.4rem .9rem;border-radius:9px;border:1px solid var(--ink);background:var(--ink);color:var(--paper);cursor:pointer}
button:hover{background:var(--teal);border-color:var(--teal)}
input,select,textarea{font:inherit;padding:.4rem .55rem;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);max-width:100%}
label{display:inline-block;margin:.3rem .8rem .3rem 0}
form.inline{display:inline}pre{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.8rem}
code{background:var(--soft);padding:.05rem .35rem;border-radius:5px;font-size:.9em}
.prose{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.9rem 1.1rem;max-width:44rem}
blockquote{margin:.6rem 0;padding:.4rem .9rem;border-left:4px solid var(--teal);color:var(--muted);background:var(--card);border-radius:0 8px 8px 0}
footer{max-width:64rem;margin:0 auto;padding:1.2rem clamp(12px,3vw,32px) 2.4rem;color:var(--muted);font-size:.88rem;border-top:1px solid var(--line)}
.tip:before{content:"Old constraints, gone: ";font-weight:650;color:var(--teal)}
@media (max-width:640px){.timeline li{grid-template-columns:1fr;gap:.1rem}.top nav{order:3;flex-basis:100%}}
`;

export function page(title: string, body: string, shell?: Shell): string {
  const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>`;
  if (!shell) {
    return `${head}
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
  const nav = shell.nav.map((n) => `<a href="${esc(n.href)}"${n.active ? ' aria-current="page"' : ""}>${esc(n.label)}</a>`).join("");
  return `${head}
<body>
<header class="top"><a class="brand" href="${esc(shell.brandHref)}">Pimwell</a>${shell.org ? `<a class="org" href="${esc(shell.org.href)}">${esc(shell.org.name)}</a>` : ""}<nav aria-label="Primary">${nav}</nav><a class="me" href="${esc(shell.me.href)}">${esc(shell.me.name)}</a></header>
<main>
${body}
</main>
<footer><p class="tip">${esc(shell.tip)}</p><p><a href="${esc(shell.brandHref)}privacy">Privacy</a> · <a href="${esc(shell.brandHref)}terms">Terms</a></p></footer>
</body>
</html>
`;
}

export function htmlResponse(body: string, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "no-store");
  h.set("referrer-policy", "no-referrer");
  h.set("x-content-type-options", "nosniff");
  h.set("content-security-policy", "frame-ancestors 'none'");
  h.set("x-frame-options", "DENY");
  return new Response(body, { status, headers: h });
}
