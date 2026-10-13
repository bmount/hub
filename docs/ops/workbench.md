# Workbench

Pimwell's signed-in application is a compact, desktop-first project console, not a landing page or a dashboard. Keep the product's existing nouns, features and permission checks. Do not invent content to fill a pane.

## Anatomy

- **Top bar:** org › project › view › object breadcrumb, Search (⌘K), + File, account.
- **Sidebar:** one 248px labeled pane: organization places and counts, then the current project heading and resource tree from `projectFeatures(kind)`, then other projects collapsed to heading links. Include the project's channels and compact copyable mail/MCP rows; show only capabilities belonging to that project kind.
- **Working pane:** the widest pane; table, list, document or graph, with actions and filters beside the content they affect.
- **Inspector:** the selected object's details, inline edits and actions, without removing the list.
- **Status bar:** request timing, sync state, keyboard hints.

The shared frame supplies this navigation on every signed-in page. Docket, Board, Status, Reviews, repository files/history/diffs and recorded Deploys use the working-pane kit. Board uses compact state-grouped tables rather than cards; selecting `work=project#number` in Board or Status keeps the view and its filters beside the same revision-protected item inspector as Docket. Reviews and code keep their native selection URLs. Project Deploys remain at `/apps?project=…#deploys`, with scope preserved when selecting and closing a record. Home and project overviews also use compact tables and URL-selected inspectors. Other pages retain their existing content markup until their pass.

Home lists active projects with kind, open work, the current viewer's unfinished attention entries (including review requests), and latest recorded activity. `project=path` opens a project summary beside that table; `work=project#number` opens the existing work inspector from Needs me. Needs me previews five entries with a link to the full list. Connect an agent and Invite a person are role-gated toolbar actions; explanatory tips stay in the status bar.

Project overviews show counts and latest timestamps by supported resource, counting current non-deleted wiki/file heads rather than revisions. `resource=key` opens that resource's recent entries in place (up to twenty, with a link to the full view). Channel counts and entries use public ownership metadata and the viewer's existing channel membership boundary. Identity and copyable MCP endpoint sit below the contents table. New page, Upload and Add contact open existing-verb forms in the inspector; multipart Upload uses native form submission. Share selects existing page/file member-mail sharing, without adding project permissions or a new sharing verb. Archived projects remain readable but expose no write actions.

### Project context and navigation

The URL's project wins. On organization places, a host-only `pmw_project` preference keeps the last visited project; it is bound to the signed-in identity and matched against this tenant's projects, never used as authorization. Without a valid preference, the first active project is shown. Archived projects remain explorable when opened directly or remembered. The switcher searches all active top-level projects (not the rail's bounded badge list). Namespaced projects await canonical web routes and are not offered as ambiguous leaf-slug destinations.

Project resources come from `projectFeatures(kind)`. Docket includes Board and Status; repository projects include code, reviews and recorded deploys; workspace/wiki capabilities add wiki, knowledge/research, files and contacts. Channels come only from the project's public channel ownership records, never from private chat discovery. Mail links filter the mailbox to the project; Deploys opens that project's recorded deployments. The explorer exposes the mail address and a copyable MCP endpoint.

Counts are request-local, read in the existing sign-in batch without a cache or extra database round trip: open work and non-closed reviews, current non-deleted wiki/research/file heads, contacts, project channels and their current live messages, admitted shared project mail, and recorded deploys. Repository/code links do not invent counts from unavailable remote git metadata.

The rail and explorer containers survive pane swaps. The rail retains scroll; explorer scroll and native disclosure state are saved per identity/project in tab-local session storage and restored on swaps and reload. Counts and breadcrumb are refreshed from the response. At ≥1280px the single sidebar is visible, or collapsed to a 36px strip by the top-bar toggle. Collapse state is saved per identity in local storage and survives reload and pane navigation. Below 1280px Menu or the sidebar toggle opens one drawer containing both organization places and project resources; phone layouts retain the breadcrumb and bottom tabs.

## Rules

1. **URL is state.** Project, view, shared filters, sort and selection belong in paths or query parameters. Back, forward, reload and copied links must restore the same context. Preserve filters while selecting objects and switching views.
2. **Select, don't navigate away.** Choosing a row fills the inspector while rail, explorer and list stay. Reuse the existing `data-href` navigation and pane keys in `workbench()`; preserve list scroll. `j`/`k` select and load; Enter also opens. Esc and Close return to the inspector's native back link. Native links remain usable without JavaScript. Do not implement a separate routing framework.
3. **Inline editing.** Inspector forms use the existing verbs, permissions and expected revision/update checks. Do not auto-replay uncertain POSTs. Destructive actions keep their existing web-only typed confirmation and fresh-proof requirements.
4. **Density is less padding, not smaller text.** Body 14px, secondary text 13px, 4/8px spacing grid, approximately 28px desktop rows, 1px separators and small radii. Phone targets and rows are 44px without shrinking text. Use aligned tables/lists, not cards.
5. **Visible first.** Core categories and frequent actions are labeled and visible. Search and shortcuts supplement navigation. Progressive disclosure is for settings and detail, not for hiding capabilities.
6. **Calm and consistent.** One accent; colors communicate state and kind, always accompanied by text. Use theme variables in both light and system dark mode. No one-off component colors or decorative card grids.
7. **Desktop-first, not desktop-only.** At ≥1280px the shell exposes one sidebar, working pane and inspector. Narrow layouts collapse navigation into drawers; phone panes stack and retain bottom tabs and the breadcrumb.
8. **Data boundaries stay unchanged.** Helpers only render already-authorized data; they do not fetch or decide access. Counts, tree entries, links and inspector content must come from the same tenant/project/mailbox checks as the existing pages.

## Tokens

`src/theme.ts` is the single source of visual values; `src/styles.ts` uses them. See [styling.md](styling.md) for assets, CSP and navigation budgets.

| Purpose | Variables |
| --- | --- |
| Spacing | `--space-1/2/3/4/6/8`: 4, 8, 12, 16, 24, 32px |
| Type | `--fs`, `--fs-md`: 14px; `--fs-sm`: 13px; `--fs-xs`: 12px; `--fs-h1`: 20px; `--fs-chat`: 14px |
| Density | `--row-h`: 28px desktop / 44px phone; `--tap`: 28px / 44px; `--separator`: 1px |
| Shape | `--r`, `--r-sm`: 4px; `--r-xs`: 2px |
| Surfaces/text | `--bg`, `--panel`, `--sunk`, `--line`, `--ink`, `--muted`, `--faint` |
| Accent | `--accent`, `--accent-soft`, `--focus` |
| State | `--state-open/doing/done/dropped/blocked` |
| Kind | `--wish`, `--snag`, `--errand`, `--quest`, `--call`, `--spark` |

## Render kit

Import helpers from `src/html.ts`. Their styles are scoped under `wb-*` so a page can migrate without breaking legacy markup. All labels, headings, hints, class attributes and link attributes are escaped by the helper. Link helpers accept root-relative paths, fragments, HTTP(S) and mailto; unsupported schemes fall back to `#`.

**HTML slots are trusted server markup**, not a sanitizer. Escape user values with `esc()` before inserting them into any `html`, `actionsHtml`, `filtersHtml`, `editHtml` or `controlHtml` slot. Validate external links separately. Never pass raw user HTML, inline event handlers or executable script into a slot.

| Helper | Contract |
| --- | --- |
| `kitTable(label, headings, rows)` | Headings `{label, className?}`; rows `{cells: [{html, className?}], href?, selected?}`. Native table and scoped column headings, horizontal overflow container, `data-href` and `aria-selected` on selectable rows. Keep a real anchor in one cell. Reuse `hide-s` for optional phone columns. |
| `kitList(label, rows)` | Rows `{html, href?, selected?}`; one-column table so selection has the same semantics and script behavior as tables. |
| `kitTree(label, nodes)` | Nodes `{label, href, count?, current?, children?, expanded?}`. Native `details`/`summary` branches for keyboard expand/collapse, positive counts, current links. A branch's row link opens its resource; the separate chevron expands/collapses children. Zero counts are hidden. `expanded` is server initial state; the explorer restores the person's expansion state across swaps. |
| `kitTabs(label, links)` | Labeled navigation with `{label, href, current?, count?}`. These are URL links, **not** ARIA tab widgets: native history/reload works. Preserve other query filters when building each href. |
| `toolbar(label, actionsHtml, filtersHtml?)` | Labeled group, action and filter slots, wrapping on narrow screens. Supply real labeled links/buttons and GET filter forms; hide actions the reader cannot perform. |
| `statusChip(label, tone)` | Text plus colored indicator. Tone is open/doing/done/dropped/blocked or one of the six kinds. Do not rely on color alone. |
| `inspectorSection(heading, rows, actionsHtml?)` | Rows `{label, html, editHtml?}` rendered as key–value pairs. An editable value is the native summary of an existing verb form, including stale-edit fields and labeled controls. Click the value to edit, Enter to save and Esc to reset/cancel; there are no separate Edit rows. |
| `formRow(id, label, controlHtml, hint?)` | Label/control alignment. Control must have matching `id`; when a hint is present, add `aria-describedby="<id>-hint"` to the control. |
| `emptyState(heading, description, action)` | Plain-language explanation of what belongs here and how to add it or clear filters, plus a labeled `{label, href}` action. Not just “Empty”. |
| `breadcrumb(links)` | Labeled ordered navigation; mark the final `{label, href, current: true}` entry current. |

`workbench()` collapses the inspector unless it has an object key or an explicit inspector focus (for creation forms). The list then occupies all available width. Selected inspectors default to 390px; their pointer/keyboard separator remembers width per host/identity. Pages supply a native `.back` link to their unselected view, used by Close and Esc. Query parameters, not just paths, distinguish selections. List keys retain the DOM during selection; scroll and bulk checks are tab-local and restored on reload. Mutation responses refresh list content without losing that state, so an inline edit updates the row too.

The Docket puts kind tabs and filters in one toolbar; bulk actions appear only when rows are checked. Each editable work field has its own existing-verb form and expected-update token. The shared quick text filter uses the `filter` query parameter, survives selections and saves, restores on reload, and follows project resource links between views. Filters specific to a page remain that page's responsibility. Body text remains 14px with 13px secondary text and approximately 28px rows.

## Evidence and verification

Run `WORKBENCH_PHASE=before WORKBENCH_ARTIFACTS=/tmp/workbench-evidence node scripts/workbench-screenshots.mjs` before editing, then repeat with `WORKBENCH_PHASE=after`. The harness bundles the actual Worker and assets, applies all migrations to disposable local D1, and seeds synthetic human sessions, projects, work, wiki, contacts and chat. Network access is denied; no production cookies or credentials are used. It checks every captured route returns 200.

Capture Home, Docket, item, Board, Status, Code, Reviews, Wiki, Files, Contacts and graph, Mail, Chat, Assistant, People, Apps, Usage, Admin and Search at 1440×900, 1920×1080 and 390×844. Later passes can reuse the baseline and harness. Code, reviews and deploys include synthetic local git and recorded-deploy fixtures; the git service never leaves the process. Empty views are real empty product states, not fabricated chart data. Upload images and manifests to the `design` wiki project's files, grouped by child item, and link the evidence in that item's closing comment. The foundation's evidence is under `workbench/198/`; shell evidence is under `workbench/199/`. Use `WORKBENCH_PAGES=home,overview,workspace WORKBENCH_PHASE=after` for the focused entry-point pass; it seeds twelve projects plus personal attention, knowledge and files, checks the 1440px working panes fit without scrolling, and exercises selection/history and existing-verb creation/upload. The same harness checks sidebar node/scroll/disclosure persistence, project context through organization places, project switching, history/reload, tablet drawers and phone tabs.

Markup coverage lives in `test/html.test.ts`; real Docket filters, project context and counts remain covered in `test/work-pages.test.ts`, `test/context.test.ts` and `test/workbench.test.ts`. `npm run test:browser:workbench` runs the screenshot harness with its browser acceptance assertions. Before shipping run the full suite, typecheck, browser acceptance, release, and check the Docket live.
