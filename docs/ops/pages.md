# Script-free project pages

Pages are versioned project bundles, rendered under the organization’s own host.
Pages is on by default for every project kind, including existing and archived projects (except private agent-source projects). An empty Pages part can still be removed; only then is `project_update` with `add: ["pages"]` needed to restore it. Members publish through
`page_publish` (MCP/API) or the Pages list’s multipart form and drop target.
`page_list`, `page_read`, `page_history` and admin-only `page_delete` manage
metadata and retained history. The `making-pages` skill is the agent guide.

`/<project>/pages/<slug>` is a viewport-filling viewer with a thin metadata bar,
copy link, history and full-screen controls; `?revision=N` pins an old version.
An immutable R2 JSON bundle (base64 assets) backs each `page_revision` row.
Content uses `/<project>/pages-content/<slug>/<revision>/<path>`, so relative
references stay pinned to that revision. On authenticated serve, bundle-local
CSS is sanitized and inlined; raster images/fonts become data URLs and embedded
SVGs are recursively sanitized before data encoding (depth 5, 50 MiB reference
expansion ceiling). Opaque sandbox documents cannot send SameSite=Lax cookies
for subresources. This embedding avoids weakening session cookies, granting
same-origin sandbox privileges or minting unauthenticated asset capabilities.
No browser request for bundle subresources is required; CSP allows data images
and, for embedded bundles only, data fonts. Download budgets reserve the actual
rendered byte length and audit the page path/revision. Namespaced projects work identically.
The viewer has no project sidebars; its sandboxed iframe cannot execute scripts
or access the application origin. Both the iframe sandbox and response CSP
apply. Trusted viewer controls use a separate hashed application script.

Uploads accept .html, .svg or .zip with root index.html. ZIP entries are inflated
with bounded streaming output; limits are 25 MiB compressed/expanded, 200 assets,
and 5 MiB per asset. Only HTML/SVG/CSS, raster images and WOFF/WOFF2 are allowed.
JavaScript files are explicitly refused. Text must be UTF-8, paths relative and
unambiguous. Every upload replaces the whole bundle; expected_revision is
mandatory, and the SQL compare-and-append prevents concurrent overwrites.
Inline MCP html/base64 is limited to 512 KiB. Omitting content returns a private
single-use 15-minute upload URL: PUT raw bytes with normal authentication.
Long-lived agent MCP credentials must first be exchanged at `POST
/api/session.start` for a run token; ordinary HTTP upload/view/API endpoints
require that run token, not the long-lived credential. The skill includes the
exact request and session cleanup.
Capabilities are hashed in `page_upload`, scoped to identity/tenant/project,
and consumed atomically. Archived projects reject writes. Source visible text
(up to 128 KiB) and titles are searched; deleted heads disappear from search.

Bundles reuse the private `project-files/<tenant>/<project>/<ULID>` R2 prefix.
The Files orphan sweep protects all page revision object references too;
project/tenant deletion removes page metadata and sweeps the same prefix.
Conflicting uploads remove their unattached object. No thumbnails are generated.

## Legacy Files rendering

The earlier Files rendering endpoint remains supported, separately from Pages.
Upload source and assets with the existing Files upload mechanisms. Keep a
bundle in one top-level folder, for example `report/index.html`,
`report/style.css`, `report/chart.svg`, and `report/images/logo.png`. Open:

```
https://<org>.pimwell.com/<project>/pages/report/index.html
```

Namespaced projects use `/<namespace>/<project>/pages/<bundle>/<asset>`.
A bundle is the first folder of a Files path, not a separate storage object.
Relative asset references resolve from the source file's folder. Bundle assets
are read at their latest revision. Individual uploads remain versioned Files;
this endpoint does not promise an atomic multi-file snapshot. Page assets are
limited to 5 MiB each when rendered, even if Files accepts a larger upload.

Supported source is UTF-8 HTML, SVG, and CSS, plus raster PNG/JPEG/GIF/WebP and
WOFF/WOFF2 fonts. Download URLs return the unmodified original, with HTML and
SVG forced to attachments. Rendering never overwrites stored source.

## Independent defenses

`src/security/pages.ts` parses HTML with parse5, then serializes only approved
HTML/SVG elements and attributes. It does not run regular-expression filters
on source markup. Unknown elements, raw-text containers, MathML, scripts,
noscript, forms and controls, frames, plugins, base and meta are discarded.
No event attributes survive. SVG foreignObject and animation elements are
excluded; use references are local fragments only. SVG responses are serialized
from the approved SVG subtree with an explicit SVG namespace.

Styles are parsed with css-tree. Only approved rules and value functions
survive; escaped identifiers, parser-recovery nodes, custom properties and
external URLs fail closed. A rejected style becomes empty. Links to stylesheets
must stay in the bundle. Raster base64 data images are allowed, but data SVG
and data HTML are not. Other resource URLs are resolved and checked against the
exact bundle prefix. Outside hyperlinks are HTTP(S)-only, user-activated, and
forced into new tabs with `noopener noreferrer`. No automatic external load
is retained. This conservative subset deliberately excludes some valid HTML,
SVG and CSS rather than attempting to support active web applications.

Every page response also has a CSP sandbox with neither allow-scripts nor
allow-same-origin nor allow-forms. The viewer document therefore has an opaque
origin. The default source is none; styles are inline or bundle-local, images
are bundle-local or data, and fonts are bundle-local. Frames and network APIs
are not enabled. Popups and popup sandbox escape are enabled solely so clicked
outside links can open normally; scripts still cannot execute in the page.
Frame ancestors are self, base and form actions are none. Responses carry
nosniff, no-referrer, and private/no-store caching. Browser font CORS/credential
restrictions still apply to opaque-origin documents; system font fallbacks are
recommended. Asset responses permit CORS reads but never skip Files access
checks or publish unauthenticated URLs.

## Authorization and maintenance

The page route uses Files' existing context, scope, organization/project
membership and feature checks, storage, download audit and download budgets.
Neither CORS nor possession of a page URL confers access. A request without
membership cannot read either markup or assets. Deleted files are not served.

Sanitize **every serve**, including old source uploaded before a sanitizer fix.
Never add a cache of sanitized HTML that can outlive its sanitizer revision.
Never allow a generic same-origin source in CSP: its path must be the bundle,
not the organization root. Avoid redirects on asset endpoints because CSP path
restrictions do not protect redirected destinations in the same way.

The regression corpus is `test/page-vectors.ts`. The real-browser test in
`test/browser/assistant.test.ts` executes it separately with sanitizer only,
CSP only, and both. It checks script side effects and dialogs, and verifies
that sanitized content initiates no outside requests. Worker integration tests
in `test/project-channels.test.ts` cover Files ingress, original downloads,
asset delivery, fresh sanitization, authentication, headers and revisions.
Pages uses this same sanitizer and headers on every asset serve, including
historical revisions. Page metadata authorization is independent of Files;
a project needs only its Pages part enabled.
