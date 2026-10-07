// The stylesheet and the workbench script, served as files whose names carry a hash of their content: browsers cache
// them for a year, and any change gets a new name. Pages link them instead of inlining them.
import { THEME_CSS } from "./theme";
import { COMPONENTS_CSS } from "./styles";
import { WORKBENCH_JS } from "./workbenchScript";

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

const css = THEME_CSS + COMPONENTS_CSS;
export const ASSETS = {
  css: { path: `/assets/app.${hash(css)}.css`, body: css, type: "text/css; charset=utf-8" },
  js: { path: `/assets/wb.${hash(WORKBENCH_JS)}.js`, body: WORKBENCH_JS, type: "text/javascript; charset=utf-8" },
};

/** GET /assets/<name>: the current file, cached for a year; an old name gets 404 so nothing stale is served forever. */
export function assetResponse(pathname: string): Response {
  const a = Object.values(ASSETS).find((x) => x.path === pathname);
  if (!a) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(a.body, { headers: { "content-type": a.type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
}
