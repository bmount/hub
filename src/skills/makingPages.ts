import type { Skill } from "./index";
export const makingPages: Skill = {
  name: "making-pages",
  title: "Making project Pages",
  summary:
    "Publish versioned script-free HTML/SVG reports, dashboards and presentations, with bundled assets.",
  body: `Use Pages for visual reports, dashboards, diagrams and presentations that fill the viewport; use Wiki for editable Markdown and Files for downloads. Pages and all their assets stay inside the organization: every read requires organization access. Never copy private content outside the organization.

Pages is on by default in every project. Only if someone removed the empty part, restore it with \`project_update {project: "demo", add: ["pages"]}\`.
1. Publish: \`page_publish {project: "demo", slug: "report", title: "Report", filename: "report.html", expected_revision: 0, html: "<html><body><h1>Report</h1></body></html>"}\`. Slugs are lowercase hyphen-separated words (100 characters). Members publish; readers view.
2. Open the returned URL on your organization's host: \`/demo/pages/report\`. The thin viewer bar has Copy link, History and Full-screen. Link it from items or Wiki using a normal Markdown link.
3. Read before updating: \`page_read {project: "demo", slug: "report"}\`, then publish the complete replacement with its current \`expected_revision\`. A stale write conflicts; re-read and reconcile. \`page_list {project}\` lists pages; \`page_history {project, slug}\` lists versions. \`?revision=1\` opens an old version with its original assets. Admins may \`page_delete {project, slug, expected_revision}\`; history is retained.

**Bundles and large uploads**
Upload one UTF-8 .html or .svg, or a .zip containing index.html at its root and relative CSS, SVG, PNG/JPEG/GIF/WebP, WOFF/WOFF2 assets. Relative paths work at any depth; no absolute filesystem paths, dot segments or ?, #, %, : in asset names. Limit: 25 MiB compressed AND expanded, 200 assets, 5 MiB each (50 MiB rendered asset-reference expansion maximum). No JavaScript files (.js, .mjs, .cjs); they are refused with an explanation. Inline html or base64 content is limited to 512 KiB. For ZIP use \`base64\`, not \`html\`.
For larger content, call page_publish with project, slug, title, filename and expected_revision but neither html nor base64. It returns upload_url (15 minutes, single use). PUT the raw file bytes to that URL with your usual Authorization header; keep the URL private. The response contains the published revision and viewer URL. Never put your bearer token into a URL.
For raw HTTP (PUTs or /api/page.publish), agents must use a short-lived run session, not their long-lived pmw_ MCP credential. Privately read the saved long-lived token; POST JSON {"label":"pages-upload","ttl":3600} to https://<org>.pimwell.com/api/session.start with Authorization: Bearer <long-lived token> and Content-Type: application/json. Keep result.session_token private and use it as Authorization: Bearer <session_token> on subsequent HTTP requests. Finish with POST /api/session.end and JSON {} using that run token. If you already have an active run token, reuse it. Do not print credentials or place them in shell arguments.
Publish visual content through page_publish; Files stores downloadable originals, not renderable pages. Bundle assets are embedded during authenticated rendering, so relative resources work without browser subresource authentication.\nThe web Pages list also accepts a file picker or drag-and-drop; use Upload new version for an existing page.

**Design within the safe subset**
No JavaScript executes, including inline scripts and event handlers. Nothing automatically loads from outside the bundle: external styles, imports, images and fonts are removed/blocked. Forms, controls, frames, plugins, MathML, SVG foreignObject and SVG animations are stripped. Styles use a conservative parsed subset: no CSS custom properties/var(), escaped identifiers or unapproved functions; an unsupported stylesheet is discarded. Ordinary clicked HTTP(S) links open separately.
Pre-render charts as SVG. Use details/summary, :hover and :target for CSS-only interactions. Use flex/grid, width:100%, min-height:100dvh and responsive media queries rather than a fixed desktop canvas. Support light and dark with color-scheme and prefers-color-scheme media queries; include system font fallbacks alongside bundled WOFF/WOFF2 fonts. All versions are sanitized again on every view, so security fixes also protect old uploads. Test desktop and phone widths and check that bundle assets still render.`,
};
