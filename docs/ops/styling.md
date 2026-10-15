# Styling

Three files, one direction of dependency:

| File | Holds | Change it when |
| --- | --- | --- |
| `src/theme.ts` | Every color, font, size, radius, shadow and layout dimension, as CSS variables, light and dark | You want a new look. Most restyles end here. |
| `src/styles.ts` | Components (rail, panes, tables, chips, forms, cards), written only with the theme's variables | A component needs a different shape |
| `src/html.ts` | Markup of the frame (bar, rail, panes, status, tabs) and the class names pages use | The structure changes |

Both the stylesheet (theme plus components) and the workbench script are served from `src/assets.ts` as
`/assets/app.<hash>.css` and `/assets/wb.<hash>.js`. Each name carries a hash of the content, so browsers cache a file
for a year and any change gets a new name. No build step is involved. Assistant, tool playground, copy,
presence and landing clients use the same static asset mechanism. The bundled landing template's trusted
script is split into its own asset before serving the page. Server-rendered data goes in escaped HTML attributes,
not executable JavaScript. Swapped panes revive only same-origin static pane clients.

HTML responses share a Content Security Policy: resources default to this origin, scripts must come from this
origin, and inline scripts, event handlers, eval, objects, base tags and framing are blocked. Inline styles remain
allowed for existing layouts; Google Fonts stylesheet and font origins remain allowed for public pages.
OAuth consent adds only the validated client's redirect origin to `form-action`, preserving approval redirects.
CSP is defense in depth, not a replacement for escaping, URL validation or access checks.

## Navigation budgets and browser telemetry

Workbench requests have a 15-second whole-request deadline (headers and body), abort on timeout, and cannot leave the progress cursor set. A newer navigation aborts its predecessor. Jump suggestions coalesce their base-list request and cancel obsolete query requests on typing, blur or navigation. GET navigation shows a notice after three seconds and an explicit Retry after failure; mutations are never replayed automatically and an interrupted POST warns that its outcome is unknown. The Assistant has a separate 60-second budget and cancels when its pane is removed. Presence already has an eight-second deadline and pane cleanup. Pages are `no-store`; assets are content-hashed and immutable. There is no service worker.

The workbench sends slow (>3 seconds) navigations/requests, failures/timeouts, and a cursor still busy after ten seconds to `/client/slow`. Reports contain only allowlisted path templates, duration, phase, result and status: no actual paths, query keys/values, response bodies, error text or identity fields. Delivery itself times out after three seconds and is not instrumented. Each page sends at most 30 reports; the endpoint accepts at most 60 per identity/minute, requires a same-origin browser session and bounds the body to 1 KiB. Reports join only the current tenant's active `pimwell-hub` app source (unregistered tenants are ignored), with at most 50 examples per group. `trace_list`, `trace_read` and Apps expose them as `kind: slow`. An additive `client_kind` column extends the original group-kind constraint without rewriting existing data. Browser reports do not infer a deploy version from the server's latest release, since an open tab may still use older assets.

## The variables

- **Type:** `--font`, and the sizes `--fs`, `--fs-md`, `--fs-sm`, `--fs-xs` and `--fs-h1`.
- **Workbench readability:** body text is 14px, secondary text 13px; density comes from a 4/8px spacing grid and approximately 28px rows, not smaller type. See [workbench.md](workbench.md) for the shared kit and migration rules.
  - Phones (760px and narrower) keep readable type with `--tap` and `--row-h` 44px touch targets and `--bar-h` 56px.
    Components size buttons, inputs and rows from these tokens, never from fixed numbers.
  - `--muted` and `--faint` keep at least 4.5:1 contrast on `--bg`.
  - `--fs-chat` sets the Assistant's reading size.
  - The bar and the tabs pad for the phone's safe areas (`env(safe-area-inset-*)`).
- **Shape:** `--r`, `--r-sm` and `--r-xs` (radii); `--elevation-1/2` for micro-elevation, `--bevel` for a top highlight, `--inset` for fields, and `--shadow` for overlays. `--focus-width/offset` size the visible keyboard ring; its outline overrides legacy inline outline resets.
- **Layout:** `--rail-w`, `--bar-h` and `--status-h`; `--space-1/2/3/4/6/8`, `--row-h` and `--separator` define shared kit density.
- **Surfaces:** `--bg` (page), `--rail`, `--panel`, `--group` (cards and grouped metadata), `--raised` (secondary controls), `--field` (inset inputs), `--hover` and `--selected`. `--sunk` aliases group. `--line` and `--line-strong` distinguish separators from control edges; `--highlight` is the surface highlight.
- **Text:** `--ink`, `--muted` and `--faint`.
- **Action:** `--accent` (teal links and selection edge), `--blue/indigo` (supporting accents), `--accent-soft` (selected row) and `--focus`. Primary controls use `--primary-gradient`, `--primary-hover` and `--on-primary`; selected navigation uses `--selected-gradient`. Existing default buttons are primary, `.quiet` and toolbar actions secondary, `.link` tertiary. Treatments change no padding, height or row geometry.
- **Semantics:** `--attention`, `--progress`, `--success`, `--warning`, `--error`; state colors alias these. `statusChip` accepts those tones as well as work kinds/states, always with text and a dot rather than color alone.
- **Work kinds:** `--wish`, `--snag`, `--errand`, `--quest`, `--call` and `--spark`.

Rules:
- **No raw values in components.** `src/styles.ts` holds no colors or fonts; add a variable instead.
- **Dark mode** is a second variable set in the same file, not separate component rules.
- **Phone and tablet** layouts are the two `@media` blocks at the end of `src/styles.ts` (at 1100 px and 760 px).
