import { parse, type DefaultTreeAdapterMap } from "parse5";
import * as css from "css-tree";

// Re-serialize a browser-parsed tree, never filtered source markup. Unknown
// namespaces and raw-text containers are discarded, not unwrapped (mXSS).
const html = new Set("html head body title div span p br hr h1 h2 h3 h4 h5 h6 section article aside header footer main nav address blockquote pre code em strong b i u s small sub sup mark abbr time ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td figure figcaption details summary a img style link".split(" "));
const svg = new Set("svg style g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask pattern symbol use image title desc".split(" "));
const attrs = new Set("id class title lang dir width height colspan rowspan scope open alt viewBox preserveAspectRatio d x y x1 x2 y1 y2 cx cy r rx ry points fill fill-opacity stroke stroke-width stroke-opacity opacity transform offset stop-color stop-opacity font-size font-family text-anchor clip-path mask patternUnits patternTransform gradientUnits gradientTransform role aria-label".split(" "));
const voids = new Set(["br", "hr", "img", "link", "col"]);
const escape = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
export type PageLocation = { origin: string; prefix: string; path: string; inline?: (path: string) => {type: string; source: string; url: string} | null };
const rasterData = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;
export function pageURL(value: string, location: PageLocation, image = false): string | null {
  if (image && rasterData.test(value)) return value;
  if (value.startsWith("#") && /^#[\w.-]+$/.test(value)) return value;
  try {
    const base = location.origin + location.prefix + location.path.split("/").map(encodeURIComponent).join("/");
    const url = new URL(value, base);
    if (url.origin !== location.origin || !url.pathname.startsWith(location.prefix) || url.search || /%2f|%5c|%25/i.test(url.pathname)) return null;
    if (location.inline) return location.inline(decodeURIComponent(url.pathname.slice(location.prefix.length)))?.url ?? null;
    return url.href;
  } catch { return null; }
}
export function pageCSS(source: string, location: PageLocation, declaration = false): string {
  try {
    if (source.includes("\\")) return ""; // No escaped identifiers or URL obfuscation.
    const tree = css.parse(source, {context: declaration ? "declarationList" : "stylesheet"});
    let invalid = false;
    css.walk(tree, node => {
      if (node.type === "Raw") invalid = true;
      if (node.type === "Atrule" && !["media", "supports", "font-face", "layer", "container"].includes(node.name.toLowerCase())) invalid = true;
      if (node.type === "Declaration" && (/^(-moz-binding|behavior)$/i.test(node.property) || node.property.startsWith("--"))) invalid = true;
      if (node.type === "Function" && !/^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|calc|min|max|clamp|linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient|repeating-radial-gradient|translate|translateX|translateY|translateZ|translate3d|scale|scaleX|scaleY|scaleZ|scale3d|rotate|rotateX|rotateY|rotateZ|rotate3d|skew|skewX|skewY|matrix|matrix3d|perspective|cubic-bezier|steps|format)$/i.test(node.name)) invalid = true;
      if (node.type === "Url") { const url = pageURL(node.value, location, true); if (!url) invalid = true; else node.value = url; }
    });
    // CSS strings cannot terminate the enclosing HTML style element.
    return invalid ? "" : css.generate(tree).replace(/</g, "\\3c ");
  } catch { return ""; }
}
export function sanitizePage(source: string, location: PageLocation, isSVG = false): string {
  const document = parse(isSVG ? `<body>${source}` : source);
  type Node = DefaultTreeAdapterMap["node"];
  let nodes = 0;
  function render(node: Node, depth = 0): string {
    if (++nodes > 50000 || depth > 128) return "";
    if (node.nodeName === "#text") return escape((node as DefaultTreeAdapterMap["textNode"]).value);
    if (!("tagName" in node)) return "childNodes" in node ? node.childNodes.map(n => render(n, depth + 1)).join("") : "";
    const el = node as DefaultTreeAdapterMap["element"];
    const inSVG = el.namespaceURI === "http://www.w3.org/2000/svg";
    if (!(inSVG ? svg : el.namespaceURI === "http://www.w3.org/1999/xhtml" ? html : new Set()).has(el.tagName)) return "";
    if (el.tagName === "style") return `<style>${pageCSS(el.childNodes.map(n => n.nodeName === "#text" ? (n as DefaultTreeAdapterMap["textNode"]).value : "").join(""), location)}</style>`;
    if (isSVG && !inSVG) return "";
    const attributes: string[] = el.tagName === "svg" ? ['xmlns="http://www.w3.org/2000/svg"'] : [];
    const get = (name: string) => el.attrs.find(a => a.name === name)?.value;
    if (el.tagName === "link" && location.inline) {
      if (get("rel")?.toLowerCase() !== "stylesheet") return "";
      try {
        const u = new URL(get("href") ?? "", location.origin + location.prefix + location.path);
        if (u.origin !== location.origin || !u.pathname.startsWith(location.prefix) || u.search) return "";
        const path = decodeURIComponent(u.pathname.slice(location.prefix.length));
        const asset = location.inline(path);
        return asset?.type === "text/css" ? `<style>${pageCSS(asset.source, {...location, path})}</style>` : "";
      } catch { return ""; }
    }
    if (el.tagName === "link" && (get("rel")?.toLowerCase() !== "stylesheet" || !pageURL(get("href") ?? "", location))) return "";
    for (const a of el.attrs) {
      if (a.namespace || a.prefix) continue;
      let value: string | null = a.value;
      if (a.name === "style") value = pageCSS(value, location, true);
      else if (a.name === "href" || a.name === "src") {
        if (el.tagName === "a" && !inSVG) {
          if (/^#[\w.-]+$/.test(value)) { attributes.push(`href="${escape(value)}"`); continue; }
          try { const u = new URL(value, location.origin); value = ["https:", "http:"].includes(u.protocol) ? u.href : null; } catch { value = null; }
        } else if (inSVG && el.tagName === "use") value = /^#[\w.-]+$/.test(value) ? value : null;
        else if (["img", "image", "link"].includes(el.tagName)) value = pageURL(value, location, el.tagName !== "link");
        else value = null;
      } else if (a.name === "rel" && el.tagName === "link") value = "stylesheet";
      else if (!attrs.has(a.name)) continue;
      // Presentation attributes can contain CSS url() references too.
      if (value !== null && /url\s*\(|\\/i.test(value) && a.name !== "style") value = null;
      if (value !== null) attributes.push(`${a.name}="${escape(value)}"`);
    }
    if (el.tagName === "a" && !/^#[\w.-]+$/.test(get("href") ?? "")) attributes.push('target="_blank"', 'rel="noopener noreferrer"');
    const start = `<${el.tagName}${attributes.length ? " " + attributes.join(" ") : ""}>`;
    return start + (voids.has(el.tagName) && !inSVG ? "" : el.childNodes.map(n => render(n, depth + 1)).join("") + `</${el.tagName}>`);
  }
  if (isSVG) {
    const findSVG = (node: Node, depth = 0): Node | undefined => depth > 128 ? undefined : "tagName" in node && node.tagName === "svg" ? node : "childNodes" in node ? node.childNodes.map(n => findSVG(n, depth + 1)).find(Boolean) : undefined;
    const root = findSVG(document);
    return root ? render(root) : '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  }
  return "<!doctype html>" + render(document).replace("<head>", '<head><meta name="viewport" content="width=device-width, initial-scale=1">');
}
export function pageHeaders(location: PageLocation): Record<string, string> {
  const bundle = location.origin + location.prefix;
  return {"content-security-policy": `sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; style-src 'unsafe-inline' ${bundle}; img-src ${bundle} data:; font-src ${bundle}${location.inline ? " data:" : ""}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "private, no-store"};
}
