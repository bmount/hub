// The stylesheet and the workbench script, served as files whose names carry a hash of their content: browsers cache
// them for a year, and any change gets a new name. Pages link them instead of inlining them.
import { THEME_CSS } from "./theme";
import { COMPONENTS_CSS } from "./styles";
import { WORKBENCH_JS } from "./workbenchScript";
import { CHAT_PRESENCE_JS } from "./chatPresenceScript";
import { ASSISTANT_JS } from "./assistantScript";
import { PLAYGROUND_JS } from "./playgroundScript";
import { COPY_JS } from "./copyScript";
import intro from "../site/index.html";

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

const css = THEME_CSS + COMPONENTS_CSS;
// Only the trusted, bundled landing template is split; never authorize scripts from response/user HTML.
const landingJs = /<script>([\s\S]*?)<\/script>/.exec(intro)![1]!;
export const ASSETS = {
  css: { path: `/assets/app.${hash(css)}.css`, body: css, type: "text/css; charset=utf-8" },
  js: { path: `/assets/wb.${hash(WORKBENCH_JS)}.js`, body: WORKBENCH_JS, type: "text/javascript; charset=utf-8" },
  presence: { path: `/assets/presence.${hash(CHAT_PRESENCE_JS)}.js`, body: CHAT_PRESENCE_JS, type: "text/javascript; charset=utf-8" },
  assistant: { path: `/assets/assistant.${hash(ASSISTANT_JS)}.js`, body: ASSISTANT_JS, type: "text/javascript; charset=utf-8" },
  playground: { path: `/assets/playground.${hash(PLAYGROUND_JS)}.js`, body: PLAYGROUND_JS, type: "text/javascript; charset=utf-8" },
  copy: { path: `/assets/copy.${hash(COPY_JS)}.js`, body: COPY_JS, type: "text/javascript; charset=utf-8" },
  landing: { path: `/assets/landing.${hash(landingJs)}.js`, body: landingJs, type: "text/javascript; charset=utf-8" },
};

export const LANDING_HTML = intro.replace(`<script>${landingJs}</script>`, `<script src="${ASSETS.landing.path}" defer></script>`);

/** GET /assets/<name>: the current file, cached for a year; an old name gets 404 so nothing stale is served forever. */
export function assetResponse(pathname: string): Response {
  const a = Object.values(ASSETS).find((x) => x.path === pathname);
  if (!a) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(a.body, { headers: { "content-type": a.type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
}
