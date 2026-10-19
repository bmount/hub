# Script-free project pages

Pages are private project Files, rendered under the organization's own host.
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
Upload/view/version-management UI and agent-facing Pages tools are separate
from this rendering/security layer.
