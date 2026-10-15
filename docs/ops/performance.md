# Site performance

## Vocabulary

- **Project**: the code (`pimwell` in MCC).
- **Site**: a running product deployment (`pimwell.com`), including its hostnames and Workers. Pimwell serves the apex and every organization's subdomain using `pimwell-hub`, `pimwell-git` and `pimwell-tail`. AgentFeed has its own site, `agentfeeds.dev`.
- **Version**: an immutable Cloudflare Worker version UUID. A recorded deployment links a version to a full commit; another deployment of the same version has a distinct deployment UUID.
- **Span**: a timed step inside a request (a verb, D1 statement, Durable Object call or external fetch).
- **Interaction**: one browser action (navigation, row selection, form submission or message send).

## Site model and access

`site` belongs to a tenant and code project, with a name and JSON hostname list. `site_app` attaches existing `app_source` registrations. Every read joins both tenant and project: attachments cannot grant access to foreign apps or records. Disabling an app, or moving it to another project through Apps, is not overridden by a site. Pending/disabled apps remain visibly pending/disabled. Registration never enables reporting.

The additive migration seeds MCC's existing top-level Pimwell and AgentFeed projects and attaches their already registered Workers. `site_register` updates a site's hostnames and app set; every app must first belong to that project through `app_register` and its existing repository declaration/root approval rules. Hostnames describe the deployment, not DNS ownership or routing authority.

`site_list` (optionally by project) and `site_read` (by name) are reader-accessible MCP tools and `/api/site.list`, `/api/site.read` verbs. The project sidebar has a Site branch with Performance, Errors and Deploys. Errors and Deploys reuse Apps, with server-side site filtering before list limits and scoped inspector selection. Performance uses the same workbench list/inspector shell. Its URL holds the measurement kind, time range, version pair, selected group and exemplar request.

## Version identity and commit resolution

Each Pimwell Worker declares `version_metadata` as `WORKER_VERSION`, available as `env.WORKER_VERSION.id`, `.tag` and `.timestamp`. It is platform-supplied, requires no secret and adds no resource permission. The release helper permits the exact additive version metadata binding, `PERF` Analytics Engine binding for `pimwell_perf`, and `PERF_TENANT_KEY` secret. The release helper also permits the exact additive `PERF_ANALYTICS_TOKEN` secret for the read-only query path. The tail Worker may add only `nodejs_compat`, needed for async-local tracing. The hub may add only `global_fetch_strictly_public` so native same-zone HTTP probes traverse the public Worker route instead of bypassing it to the origin. OAuth Client ID Metadata Documents remain explicitly disabled. Other binding/runtime changes still fail closed.

Site responses expose each app's latest **recorded production deployment**, its version UUID, deployment UUID, deploy record ID, recording timestamp and supported commit reference/link using the existing deploy-record interpretation. There is no privileged Cloudflare API token in the request path. These records describe the last reported deployment, not an independent live rollout check; an unreported manual deploy or rollback can make them stale. Unknown commits and missing release records remain null, never guessed from abbreviated tags or opaque versions. Release tooling checks Cloudflare's live deployment and records all three Workers, including the tail consumer which has no public route.

## Measurement boundaries

The three Pimwell Workers write to Workers Analytics Engine dataset **pimwell_perf**, through optional binding **PERF**. HTTP dispatch, cron, email and tail delivery have root traces. Every verb is wrapped at definition and every page/API route at registration. Durable Object public methods and storage are wrapped once; hibernatable WebSocket messages get independent external request roots (`method=websocket`), not internal RPC roots, so acknowledgement interaction points can join their command roots. No queue consumer is currently configured. KV, R2, service bindings, Artifacts methods, outbound fetch (hostname only), model providers and HTML frame builders have spans.

The `span(name, fn)` tracer in `src/perf.ts` supports synchronous/async functions, nesting, exceptions and concurrent requests through async-local storage. Binding wrappers preserve native receivers, including callable RPC properties. Internal service requests/RPC calls carry a content-free trace envelope; receivers strip it before business handlers execute. Only the service-only Git Worker and namespace-only Durable Objects consume it. Public hub requests never trust a client trace envelope. Child invocations share the request ID and parent span, but use their own version, isolate-cold flag and span ID range. RPC roots have kind **rpc**, so they do not double-count external requests.

D1 statements have a fingerprint of normalized SQL plus a code call site (bounded stack capture skipping instrumentation frames, bounded isolate caches). Literals/comments never enter exported telemetry. `first` executes `all` once and projects the first row/column to retain metadata; `raw` preserves native semantics and lacks native metadata. `prepare`, `bind`, `batch`, `exec` and sessions retain their behavior. A batch has one trip span plus statement details, each sharing the measured batch wall time with its own D1 metadata; do not sum those detail wall times as independent trips. Native `meta.duration`, rows read/written, region and primary status are retained where D1 supplies them. Wall minus execution is an approximate transport/queue residual, not a pure network measurement.

The Workers clock advances across I/O, not synchronous CPU work. Synchronous render spans can consequently read zero; native invocation CPU is the authoritative CPU measure. Current model providers are non-streaming: first-token time means first decoded text availability, not first network byte.

## Point schema (v1)

**index1 is a request-scoped sampling key**, not a version or authorization dimension. Server roots use `request:<request UUID>` or `rpc:<request UUID>`, detail (`span` and `other`) shares `trace:<request UUID>`, native timings use `invocation:<request UUID>`, and browser points use `client:<phase>:<request UUID>`. Missing request IDs on client/native points get a fresh random UUID in the index only; blob 6 stays empty. Version remains **blob3**. Roots and browser phases do not compete with high-volume trace detail; internal calls share the detail key. Identity is repeated in blobs so queries need not infer it from the index. Empty tenant/colo mean an unscoped invocation or unavailable platform metadata, never a fabricated tenant/region. Tenant IDs are HMAC-SHA-256 pseudonyms truncated to 128 bits, using the shared **PERF_TENANT_KEY** secret on hub and Git Workers. It grants no authorization. For isolated/local setups without that key, the existing internal/secrets key is a fallback; without any key the tenant dimension is empty. Only completed hash strings are cached: native I/O promises cannot be shared across invocation/DO contexts. Key rotation changes pseudonyms; never expose the key in queries or product responses.

| Blob | Meaning |
| --- | --- |
| 1 | Site name (`pimwell.com`) |
| 2 | Worker script name |
| 3 | Immutable Worker version UUID |
| 4 | Request `cf.colo` (propagated to internal calls and WebSocket attachments) |
| 5 | Keyed tenant hash |
| 6 | Server request ID |
| 7 | Kind: `request`, `rpc`, `span`, `other`, `invocation`, `client` |
| 8 | Executed route template, or code-defined event name |
| 9 | HTTP method, or event kind |
| 10 | Status class (`2xx`, etc.) |
| 11 | Auth kind: cookie, MCP, API token, git, agent, anonymous |
| 12 | Canonical verb name (never an unknown input verb) |
| 13 | Canonical MCP tool name |
| 14 | Span name / `request` / `invocation` |
| 15 | SQL-and-call-site fingerprint; no SQL text |
| 16 | D1 served-by region |
| 17 | Model provider |
| 18 | Model identifier |

| Double | Meaning (milliseconds unless noted) |
| --- | --- |
| 1 | Wall duration; batch detail shares its trip duration |
| 2 | Cold isolate (0/1: first traced invocation in that isolate) |
| 3 | Span ID (0 for root/native invocation) |
| 4 | Parent span ID (0 for an external root) |
| 5 | Failed (0/1) |
| 6 | D1 execution duration; -1 if unavailable |
| 7 | D1 rows read; -1 if unavailable |
| 8 | D1 rows written; -1 if unavailable |
| 9 | D1 served-by-primary (0/1); -1 if unavailable |
| 10 | Model first-token availability; -1 if unavailable |
| 11 | Represented span count (1 normally; excess count for `other`) |
| 12 | Cloudflare native CPU time (`invocation` points only) |
| 13 | Cloudflare native wall time (`invocation` points only) |
| 14 | Complete span (1) or still pending at telemetry snapshot (0) |

One external request/root point and up to 199 retained spans are emitted, plus one `other` summary if the cap is exceeded (at most 201 points). Excess spans fold their count and elapsed durations into `other`; nesting means wall durations overlap and must not be naively summed. Span IDs stay within exact JavaScript/Analytics Engine numeric range and are allocated in separate ranges for internal invocations. Native CPU/wall points come from `pimwell-tail`, which consumes only the measured hub/Git Workers for this dataset and joins their content-free completion marker. It never reads request headers, bodies or URL values into points. The tail processor has its own root/operation spans but is not its own tail consumer (avoids recursive telemetry).

Responses carry **X-Request-ID** and **Server-Timing** (application/D1 totals and eight longest spans). Response/upgrade headers are preserved. Writes use `waitUntil` and the native scheduler after dispatch; no body-deadline/application timer is introduced. Root wall time is frozen at dispatch completion. MCP body work and background turns drain after dispatch for at most 25 seconds, within the platform waitUntil lifetime; the native drain timer is cancelled when work completes. This never holds or cancels a product response. Still-pending work at that bound is explicitly marked incomplete and measured to the telemetry snapshot rather than awaited indefinitely. Delivery is best-effort and cannot fail a product response.

## Source catalog and v2 timing

`node scripts/perf-catalog.mjs --annotate` maintains neutral `perf-site` SQL comments and generates `src/perfCatalog.ts` from code literals/templates, with file/function/line/column locations. Regenerate it after tracing/query-source changes, repeating until unchanged if several calls share a line. SQL executes with the same bindings and semantics; comments give each prepare call a stable, source-defined identity instead of relying on bundled stack locations. Runtime SQL, interpolated values and bound parameters never enter telemetry. The catalog contains normalized source statements or explicitly labeled source templates/expressions, never substituted user values. Literal-only legacy queries may have several candidate sites; new annotated points carry their exact site. Blob 19 on server points holds a source-defined location; blob 20 holds the SQL catalog key (the per-call-site fingerprint remains blob 15). Dynamic binding spans skip `src/perf.ts` frames and resolve the first application function through the source catalog, falling back to the enclosing application span. Unresolved sources stay absent rather than pointing at the instrumentation. Client blob 19 retains its previous-route meaning; client blob 20 links to the collector.

Server points with double 20 = 2 add double 15 (start offset from invocation), double 16 (approximate epoch start in milliseconds), double 17 (attributed wall time), double 18 (internal RPC flag) and double 19 (attributed D1 execution, or -1 if unavailable). Each interval inside the dispatched root belongs to the deepest active spans; concurrent leaves share that interval equally. Thus nesting, overlapping siblings and D1 batch statement details cannot multiply the root's wall time. Attribution is an explanatory allocation, not proof of which concurrent branch caused a wait. Internal RPC points are excluded from route stacks because the calling stub already accounts for their wait. Native D1 execution is allocated in proportion to the statement's attributed wall time; unavailable execution remains a separate unknown segment. Older points lack these fields and must not be shown as zero-duration breakdowns. `other` cap summaries have no invented start timestamp or additive attribution. Internal invocations use their own epoch clock, so cross-isolate waterfalls have clock-resolution uncertainty.

## Sampling and SQL

All requests are submitted; Analytics Engine can downsample on ingestion/query. **Always weight counts, means and distributions with `_sample_interval`**. Do not use raw `COUNT(*)` as a traffic total. Request-scoped keys keep rare roots/browser phases at normal traffic even when detail is downsampled. This is not an atomic whole-trace retention guarantee: high-volume detail or query sampling can still lose parents, and sufficiently hot root/client keys can also be sampled. Missing points are not zero time or proof of failed emission. **Cutover (#230):** older releases indexed all points by Worker version UUID, so span volume could drop rare roots and browser points. Old data is not rewritten or recoverable. Filter versions on blob3 and requests on blob6 across both schemes; the Performance view/MCP queries already use these blob dimensions and retain sample weights. Filter kind `request` for external/event requests, `rpc` for internal roots, and `invocation` for native CPU. Filter by the authorized site and its active registered Workers before exposing aggregates through the product; account-level SQL access alone is not product authorization.

Example version query (replace the UUID; Cloudflare Analytics Engine SQL API):

```sql
SELECT blob2 AS worker, blob7 AS kind, blob8 AS route,
       SUM(_sample_interval) AS represented_points,
       SUM(double1 * _sample_interval) / SUM(_sample_interval) AS mean_wall_ms
FROM pimwell_perf
WHERE blob3 = 'worker-version-uuid'
GROUP BY worker, kind, route
ORDER BY represented_points DESC
```

Native CPU for the same version:

```sql
SELECT blob2 AS worker,
       SUM(double12 * _sample_interval) / SUM(_sample_interval) AS mean_cpu_ms,
       SUM(double13 * _sample_interval) / SUM(_sample_interval) AS mean_native_wall_ms
FROM pimwell_perf
WHERE blob3 = 'worker-version-uuid' AND blob7 = 'invocation'
  AND double12 >= 0
GROUP BY worker
```

Guardrails in `test/perf-budget.test.ts` enumerate every registered route, verb and public Durable Object method, assert actual span emission, cover both scheduled handlers, exercise page/API/MCP/git/chat collection and check content/credential exclusion, nesting, failures, D1 metadata and the cap. The existing deadline tests ensure tracing does not change cancellation/timer behavior. `node scripts/perf-overhead.mjs` measures warmed CPU-only overhead against fake I/O at ordinary, capped and overflowing span counts; the host suite asserts <1 ms. This isolates tracer/serialization cost and explicitly excludes native Analytics Engine ingestion; live native invocation CPU provides the production cross-check. Browser collection is described below; synthetic collection and authorized product querying are separate quest items.

## Synthetic baseline

The hub's existing `*/5 * * * *` Cron Trigger runs `src/synthetic.ts` against the public live hosts. Migration 0033 seeds a system-owned `perf-synthetic` organization, flagged synthetic human member, permanent `perf-synthetic` workspace with item #1, a `synthetic` channel and a `fixture` repository. It is not a disposable `tmp-` workspace. Synthetic members/organizations are omitted from member/admin organization lists and synthetic model calls from usage aggregates. Fixture credentials are pinned to this organization, never to a real organization's projects, channels, mail or repositories.

Fixed journey labels:

| Label | Live check |
| --- | --- |
| landing | Anonymous `https://pimwell.com/`, loaded and painted in Chromium |
| sign-in | Anonymous `https://pimwell.com/login`, loaded and painted |
| home | Signed-in `https://perf-synthetic.pimwell.com/` |
| docket | Signed-in `/docket` |
| item | Signed-in `/perf-synthetic/w/1` |
| chat-page | Signed-in `/c/synthetic` |
| mail | Signed-in `/mail` |
| tools/list | OAuth-authenticated MCP tool discovery on `/mcp` |
| work_read | MCP read of `perf-synthetic#1` |
| search_query | MCP search for the fixed fixture title |
| chat-post | Idempotent fixed check message in the synthetic channel |
| chat-read | Read back and verify that tick's posted message |
| git-ls-remote | Protocol-v0 smart-HTTP ref advertisement for the isolated `fixture.git` repository |

The Git journey performs the exchange used by `git ls-remote` (validates the advertisement content type and parses pkt-line refs), not a shell subprocess: Workers cannot execute native Git. It uses native Worker fetch against the public authenticated Git URL, not Chromium/CDP transport, because Git is not a browser interaction. Redirects are not followed with the fixture credential; browser page journeys remain on Browser Rendering. MCP POSTs use the same SDK's remote HTTP transport (`route.fetch`, with redirects disabled), since Chromium re-adds Origin to continued POSTs and headless MCP must not inherit the fixture page's browser origin. The server's browser-origin policy is unchanged. An empty freshly provisioned repository is a valid advertisement. `git-fixture-setup` separately times project lookup, Artifacts ownership checking/provisioning and the local mapping write on every run. Its timing and failure observation use coordinator/health-probe metadata, not Git response metadata. `git-ls-remote` times only one authenticated public advertisement exchange, including reading and parsing the response; it never provisions, repairs or retries. The read is attempted even if setup fails, so a setup failure and a read failure (or success against existing storage) remain independent evidence. Both labels retain latest outcomes, emit Analytics Engine points and open failure-episode Situations. Setup time is not included in the Git read budget. No real repo is used.

The browser runs through the `SYNTHETIC_BROWSER` Browser Rendering binding using Cloudflare's supported `@cloudflare/playwright` SDK. This remote-only SDK avoids Puppeteer's unused Node browser downloader/archive/FTP dependencies. Each run uses an isolated context with service workers blocked so all requests pass through the destination/header guard. Page readiness means a successful non-redirected document, the signed-in timing collector present, load completion and two animation frames, not a fixed sleep. Browser requests are restricted to the apex and synthetic organization host; third-party requests are aborted. The Worker mints four-minute browser/Git sessions and an OAuth grant, uses them only inside the Worker/browser service and revokes/removes them after the tick. No bearer/cookie is logged, stored as plaintext, exported to an agent or returned from an API. Interrupted credentials expire and stale D1 rows are cleaned by the next tick. OAuth library clients/grants are deleted after use.

Every journey emits kind `synthetic`, blob8/blob14 = its fixed label, blob3 = deployed version, blob4 = response colo, double1 = elapsed milliseconds and double5 = failure. Version/colo come from the origin response; failed setup falls back to the health probe's metadata (colo is explicitly `unknown` if the origin cannot be reached). Setup failures produce failed observations for all unattempted journeys, never fabricated successes. `synthetic_run` retains only the latest outcome/timing per label, for operational verification and episode deduplication, not user content.

Authenticated fixture requests and browser beacons are kind `synthetic` too. The fixed Git advertisement uses its own tenant's synthetic classification instead of also sending the anonymous-page marker, avoiding a redundant session lookup. Anonymous apex pages still require the live marker. Anonymous browser documents carry an ephemeral marker, checked against a live fixture session before classifying telemetry; an arbitrary header cannot suppress real-user points. Performance queries explicitly exclude this kind, including span/tool/interaction populations. No synthetic point enters real-user latency distributions.

A transition into failure creates one Situation per journey in the synthetic organization, with fixed journey/version/colo metadata and no response contents. Repeated failed ticks do not flood Situations; recovery followed by another failure opens a new episode. A site operator with root web access can inspect `https://perf-synthetic.pimwell.com/situations`; the synthetic member is never added to the real site's organization. Latest outcomes are available to operators through D1 `SELECT * FROM synthetic_run ORDER BY journey`; Analytics Engine observations can be checked with `WHERE blob7 = 'synthetic' AND blob9 = 'journey'`, grouped by journey and five-minute timestamp buckets. The journey phase distinguishes end-to-end measurements from synthetic origin/client detail.

Workers tests exercise the live page/API/MCP handlers with a stub browser transport, isolation/marker expiry, all fixed journey outcomes, credential cleanup and Situation failure/recovery deduplication. They do not describe stub Chromium timing as live measurements.

## Latency budgets and automatic Situations

`src/perf/budgets.ts` is the source of truth for p95 limits:

| Measurement | p95 limit |
| --- | --- |
| Signed-in document GET, server dispatch (cookie auth, excluding API and Git routes) | 300 ms |
| Pane swap, input to paint (`pane.swap`) | 500 ms |
| Form submit, input to paint (`form.submit`) | 800 ms |
| Visible spinner, grouped by route | 1,000 ms |
| Completed MCP tool span | 400 ms |
| Synthetic Git ls-remote journey | 1,000 ms |

The existing five-minute scheduler calls `src/perf/checks.ts`. Each active site's registered Worker is first eligible 30 minutes after its latest recorded production deploy (normally checked within five minutes), then hourly after a successful evaluation. Deploy identity comes from the same release records as Sites, not an inferred commit. A new deploy bypasses the previous deploy's hourly cooldown. Failed SQL reads do not advance the checkpoint; they retry on the next tick and cannot resolve an alert.

Checks use complete points, site/Worker/version filters and weighted p95, grouped by route. The current window is the last hour, bounded by the new deploy's recording time. The baseline is the last hour before that recording time, bounded by the preceding production deploy. A budget breach requires p95 strictly above its limit and at least **30 retained samples** (not represented traffic). The Situation title includes the retained count. Falling below the evidence floor resolves an existing budget Situation as no longer qualifying; missing windows remain unknown. Synthetic Git is exempt from the sample floor: the two latest distinct runs in the current version/window must both exceed the budget. Synthetic budgets and regression baselines are grouped by vantage colo (route keys include ` @COLO`), never compared across colos. A single slow run, repeated checks of one run, or a colo move cannot qualify. Legacy unpartitioned synthetic Situations must be rechecked and resolved when replacing them with vantage-specific evidence. A deploy regression is p95 **at least 25% higher**, with **at least 200 retained observations on each side** (raw `COUNT()` is used only as this conservative evidence floor, never as represented traffic). The baseline must have a positive p95. All external HTTP routes are additionally checked for server-time regressions, even when no absolute budget applies (for example anonymous pages or token-authenticated API calls). Non-Git populations exclude synthetic traffic by kind; Git uses only the fixed synthetic journey label. Browser version is the beacon receiver's version, with the delayed-beacon caveat described below.

A failing route/budget opens one Situation per failure episode in the site's owning organization, without a model call or user content. Its report links the deploy and full recorded commit, identifies the route and names the matched span with the greatest p95 growth (or explicitly says unavailable). `perf_alert` retains structured deploy/commit/span references. The system-owned synthetic identity authors these reports but is **not** added to the site's organization. Repeated failures do not flood Situations. A later measured passing window records automatic recovery; missing current-window routes or insufficient regression samples cannot resolve an episode. Once an episode is at least 24 hours old, a check also looks for retained observations over the last 24 hours across versions, scoped to its site, Worker, budget population and route (plus colo for partitioned Git alerts). Zero retained observations resolves it with a no-recent-data outcome, explicitly leaving performance recovery unknown. Any retained observation preserves the existing evidence rules. A recurrence opens a fresh Situation and preserves the earlier report.

The project Status line reports met/total budget categories across checked Workers, unknown categories, and the oldest check time; evidence older than two hours is marked stale. A category counts as met only when it has observations and every observed route passes. No observations is unknown, not a pass. The six limits apply independently per Worker; Workers without relevant traffic can have all six unknown. Situation reports and Status summaries are tenant/project-scoped; no measured organization identity or request contents are copied into them.

`test/perf-budget.test.ts` supplies synthetic 200-point populations at the exact 25% boundary, checks budget and regression Situations' deploy/commit/route/span references, deduplication, recovery, sparse/absent data and scheduler cooldowns.

## Performance over MCP

`perf_summary`, `perf_route`, `perf_compare`, `perf_exemplar` and `perf_statements` reuse the workbench queries and authorization. All take a registered `site` name and `hours` (1, 24 or 168, default 24). By default they aggregate every organization’s traffic, including unscoped invocations, on that site. Set `only_my_org: true` to restrict every query to the viewer’s keyed tenant hash. No tenant hashes, names, slugs, people, projects or organization IDs are returned; there is no organization grouping or lookup. Summary returns the top 200 routes and interactions by sample-weighted total waiting time. Route, exemplar and statements take `selected` and optionally `kind` (routes by default, or interactions, verbs, tools, spinners) and `version`. Route details are queried directly, even outside the overview's top 200. Compare takes `version` and `previous` and returns route metrics side by side. Exemplar defaults to the slowest retained request; optional `request` must belong to the selected group's five slow exemplars. Statements include fingerprint, recorded source/call site and version. Durations are milliseconds; absence of observations is not zero latency. Unavailable reporting returns a sanitized `performance_unavailable` error.

These reader tools require active tenant membership, an active code project and that site's registered active Workers, just like the view; project MCP endpoints expose them only for code projects and cannot query another project's site. Analytics credentials and SQL are never returned to callers.

## Performance workbench

`/apps?project=pimwell&site=pimwell.com&view=performance` opens routes, sorted by sample-weighted total waiting time. `kind` selects routes, verbs, tools, interactions, spinners or deploys; `hours` is 1, 24 or 168. `selected` opens the inspector and `request` selects one of its five slowest retained exemplars. `version` filters a recorded version; `previous` chooses its comparison. Defaults compare the latest recorded hub (or primary app) version with the next older version of that same app. Unknown versions, groups and foreign sites are not guessed. All state is preserved in native links and GET forms, including browser history, reload and pane selection.

The hub uses account-owned **Account Analytics Read** credential `PERF_ANALYTICS_TOKEN`, never a deploy credential. Queries go to the account in `ARTIFACTS_ACCOUNT_ID`. Before every query/cache read, the authenticated organization's membership, active code project, site tenant and current active app attachments are checked. Projects use the existing organization membership boundary; channel and agent-source projects cannot have sites. SQL filters site and authorized script names before aggregation across all organizations. The optional `only_my_org=true` URL filter adds the viewer’s keyed tenant identity; only this filter requires a tenant key and fails closed without it. Membership still refers to the site’s owning organization/code project, never the measured organizations. Tenant hashes used internally for client/server joins and exemplar narrowing are removed from results. Request UUIDs are content-free trace handles, not organization/person/project IDs. Cross-organization exemplars retain only fixed route/span labels, code-defined sources, SQL fingerprints and timing/operational metadata. Disabled, moved and foreign app attachments cannot grant reporting access. Account-wide SQL access does not imply account-wide product visibility.

Analytics results are cached for 60 seconds in an isolate, as plain values only, with bounded entry and byte budgets. Every count, quantile, histogram and mean uses `_sample_interval`. Route errors include HTTP 4xx/5xx; verb/tool errors come from their own timed spans, not the MCP transport's early response headers. Incomplete call spans remain visible in waterfalls but are excluded from completed-call latency distributions. Client error rates are not collected. The default list is capped at 200 groups, trends at 3,000 grouped buckets, server attribution at 5,000 **route summaries** (not trip or span rows) and paired browser observations at 5,000 grouped points. Cached analytics values are copied before use so reader annotations cannot mutate another view's results.

Route attribution uses one SQL query: WAE sums the recorded v2 span detail per tenant/request/route, caps each trip's detail at its root wall, and aggregates route summaries using root sample weights. Each v2 span is emitted once per request/span ID, so its recorded duration is already the normalized per-span value; span sample weights are not applied a second time. Missing roots are excluded, and missing sampled span detail is not extrapolated into fabricated attribution. All retained trips contribute before the route-summary limit, so a busy route's span volume cannot truncate a quiet route. The query runs alongside overview/trends/browser queries and its plain-value cache is shared across list, inspector and waterfall selections. Inspector reads prioritize the exemplar query before independent split/list work fills outbound fetch slots. SQL and waterfall queries follow the authorized exemplars immediately, without waiting for split distributions. Histogram bucket counts are exact sample-weighted conditional sums in the list aggregate, not a separate remote query or a reconstruction from quantiles; the selected row supplies its histogram without narrowing other list rows. Inspector selection does not narrow other list rows. The server bar includes **Unattributed server** (root wall minus attributed spans, never negative), including idle gaps and missing sampled detail. Browser network/ready residuals join authorized client and server request IDs. Missing roots are omitted, not assigned zero server time. Browser network includes transport, queues and body decoding; page render/ready also includes subresource readiness, not just CPU. Streaming server work may outlive dispatch. Client colo/version/auth/cold splits join up to 2,000 recent weighted points to origin root metadata; missing roots stay Unknown instead of inheriting beacon reception metadata. SQL details for client interactions come from their five exemplars. Spinner inspector rows show the fixed triggering action and previous/current route templates, ranked by total shown time. Histograms, split metrics, normalized code statements/templates and sampled waterfalls share the inspector. Source links use only full recorded commits and exact recorded source locations; unknown commits stay unlinked. The repository file inspector supports line anchors.

`WORKBENCH_PAGES=performance,performanceRoute,performanceVerb,performanceTool,performanceInteraction,performanceSpinner,performanceDeploy npm run test:browser:workbench` covers all views at desktop/phone widths, selection, history, reload, source links and layout with explicit local SQL fixtures. Production evidence is captured separately against live authorized Analytics Engine data; synthetic fixtures are never described as live traffic.

## Browser timing

The signed-in frame loads a content-hashed collector before its deferred pane clients. Existing `/client/slow` error grouping is unchanged. `POST /client/timing` accepts only a same-origin browser-cookie session (and tenant membership on tenant hosts); it accepts no client-supplied tenant, version, identity or source. Apex account pages use an empty tenant dimension. The existing KV limiter allows 120 batches/minute **per session**, not per identity; its eventual-consistency limits apply here too. Each request is bounded to 32 KiB and 100 points. The client keeps at most 300 unsent points, drains batches of 100 with `sendBeacon` on pagehide/hidden visibility, and also drains at the high-water mark. Delivery is best-effort and never blocks or retries product writes.

Every point has six required keys: `path`, `previous` (route templates), `name`, `phase` (fixed labels), `request` (server UUID) and `duration` (finite 0–3,600,000). New collectors add optional `at`, the browser's epoch start timestamp, bounded to within 24 hours of receipt. Legacy six-key batches remain accepted. Browser clocks are untrusted; timestamps give waterfall position, not proof of server ordering. No URL queries, project/channel/person names, text, selectors, form fields or message contents enter the wire format. Navigation response `Server-Timing: request;desc="<UUID>"` mirrors `X-Request-ID` so Navigation Timing can read it without an extra fetch. Enhanced fetches use `X-Request-ID`; their paint/fetch/indicator points join that response. Input-only work, aborted/unacknowledged waits and responses without readable headers retain the initiating page's server ID, **not an invented ID for an unseen response**. Client IDs/measurements are untrusted observations; join server data by keyed tenant hash as well as request ID, even in the site-wide population.

### Fixed allowlists

Markup is marked `data-perf`; the collector supplies fixed defaults for native forms, table rows, links, inline inspector disclosures and search inputs, including replacement panes. Assistant and chat composers carry explicit names. Only the following names are accepted:

- Page: `navigation`, `network`, `render`, `dns`, `connect`, `tls`, `ttfb`, `response`, `dom.interactive`, `load`, `lcp`, `cls`, `longtask`.
- Interaction: `list.select`, `docket.select`, `pane.swap`, `form.submit`, `inspector.open`, `chat.send`, `assistant.send`, `search`.
- Live/voice: `chat.connect`, `chat.reconnect`, `presence.connect`, `presence.reconnect`, `assistant.first-token`, `voice.transcribe`, `voice.correct`.
- Phases: `page`, `paint`, `fetch`, `ready`, `render`, `spinner`, `connection`, `first-token`, `resource`, `hover`, `cache`.
- Attribution: `resource`, `resource.dns`, `resource.connect`, `resource.ttfb`, `resource.response`, `resource.cache-hit`, `resource.network`, `pane.retained`, `pane.replaced`, `hover.eligible`, `hover.none`.
- Routes: `/`, `/docket`, `/people`, `/apps`, `/jump`, `/search`, `/assistant`, `/assistant/tools`, `/assistant/chat`, `/do`, `/new`, `/attention`, `/mail`, `/mail/:message`, `/mail/recipients`, `/c`, `/c/:channel`, `/c/:channel/t/:number`, `/inbox`, `/usage`, `/situations`, `/archive`, `/skills`, `/skills/:skill`, `/projects/new`, `/me`, `/me/sessions`, `/admin/:section`, `/people/:person`, `/:project`, `/:project/docket`, `/:project/w/:number`, `/:project/graph`, `/:project/frontier`, `/:project/board`, `/:project/status`, `/:project/code`, `/:project/files`, `/:project/reviews`, `/:project/reviews/:number`, `/:project/wiki`, `/:project/wiki/:slug`, `/:project/documents`, `/:project/contacts`, `/:project/contacts/:entity`, `/api/:verb`, `/voice/:operation`, `/chat/v1/ws`, `/other`.

`src/clientTiming.ts` is the shared server/browser vocabulary. New labels must be added there and here, never inferred from visible/user text.

### Interpretation and joins

Client points reuse the v1 identity columns and `double1` for the measurement. For kind `client`, **blob8** is the client route template, **blob9** is the phase, **blob14** is the allowlisted name, and **blob19** is the previous route template. **blob6** is the joined server request ID, never the beacon POST's ID. New client points have double 16 = browser epoch start and double 20 = 2; older clients omit them. `double10` also holds first-token availability for `first-token` points; other server-only fields retain their unavailable/default values. Version/colo describe the receiving hub invocation; a delayed beacon can cross a deployment boundary, so use the joined server point for the origin response's version/colo. Never sum overlapping phases or shared chat/presence measurements.

DNS/connect/TLS/TTFB/response are Navigation Timing differences. `network` spans navigation start to response end (including server time); `render` spans response end to load readiness (including subresources and browser work). Joined network residuals subtract the matching server root, never add TTFB to an already complete fetch duration. DOM interactive and load are offsets from navigation start. LCP is the latest available candidate offset; CLS is unitless (the maximum session window: 1 s gaps, 5 s maximum), not milliseconds. Vitals belong to the original document/server ID even after enhanced pane changes. CLS/LCP snapshots may be sent again after visibility resumes; use their maximum per document request, not their sum. Long tasks are individual durations where supported. Unsupported observer APIs omit those measurements rather than report a fabricated zero.

Input-to-next-paint uses Event Timing where available (16 ms threshold), otherwise a task after requestAnimationFrame. Pane readiness uses the same post-frame fallback, from the initiating click (or fetch start without an input action). Interactions rank `ready` observations, not next-frame paint; fetch, post-body pane readiness and paint means are separate columns, joined by tenant and request to up to 2,000 recent ready observations (not mixed with paint-only history). Paint-only historical points are omitted. Routes exclude scheduled, tail, RPC ingest and alarms, which have a Background tab. Errors count 5xx, failed or incomplete requests; 4xx responses have their own count. Attribution excludes batch statement detail rows and is bounded by the represented root wall time. Exemplars prefer timed, source-recorded observations; legacy source limitations are noted once per inspector. Native same-origin links/forms carry only an allowlisted action and bounded timestamp across navigation in sessionStorage, joining the destination document's ID; their fetch duration is navigation responseEnd. BFCache restoration has zero network duration and reuses its document's server ID. Enhanced navigation separately records fetch/body/render completion, the progress cursor's visible wait, and the new route plus previous template. Inline submit controls, Assistant thinking dots, live chat send controls and voice busy indicators also record their waits and triggering action. An aborted wait without a response can only join its initiating document.

Chat and socket presence share one authenticated WebSocket. Its first `connected` frame carries the upgrade's server request ID (also in the response header); connect/reconnect points measure attempt-to-authenticated-readiness, excluding reconnect backoff. Chat command acknowledgements carry their server invocation ID for send/indicator joins, distinct from the client's command correlation ID. The current Assistant is non-streaming: first-token means first decoded reply text availability, not first transport byte. Telemetry does not clone/consume extra response bodies or alter cancellation deadlines. Only successful, nonempty reply text inside the existing response deadline produces Assistant first-text points; a successful HTTP envelope alone is insufficient.

### Attribution eligibility and controlled acceptance

Resource observations are bounded to 40 same-origin static subresources per document (script/link/image/CSS/font initiators). Only fixed phase labels and durations leave the browser, never resource URLs. They join the **document** request, not a fabricated resource server root. Positive decoded body size plus zero transfer size indicates a browser cache hit; positive transfer size is the network comparison, including revalidation. Zero-body and cross-origin/redacted entries have unknown cache status, not a cache hit. Resource DNS/connect/TTFB/response phases can be zero when connections are reused; do not add overlapping resource/page measurements.

`pane.retained`/`pane.replaced` report the actual keyed pane decision in enhanced navigation, not an HTTP cache or a fetch avoided. Both can occur on one request (retained list, replaced inspector). Their duration is navigation-start to decision; compare joined ready/spinner points separately. No pane prefetch/cache is introduced. `hover.eligible` measures pointer-entry to click for same-origin nondownload links without a target, reload marker or fragment; `hover.none` is a zero-duration **absence marker** for an eligible click without a recorded pointer entry. Pointer exit clears eligibility timing. These are observational cohorts, not a claim that hover prefetch exists or causes a speedup. Native navigation and unrelated inputs do not fabricate hover samples.

The Worker entrypoint loads HTTP routing and the verb registry only for HTTP, mail or scheduled handling, not when activating a Conversation or Inbox. Socket authorization initializes the same verb registry on demand in its own Inbox isolate; authorization checks are unchanged. Telemetry RPC ingestion also avoids loading the HTTP router.

`double2` remains module/isolate first-trace (caller cold for request roots); it is **not** a DO activation flag. `do.receiver.first-entry` and `do.receiver.reused` are content-free per-instance handler-entry markers, independently tracked for each receiver, including hibernation reactivation. Marker duration is instrumentation overhead, **not startup time**. Constructor/module load, scheduling, network transit and pre-handler activation time are unobserved and cannot be separated from caller wait. Colo inherited across RPC describes the originating request, **not DO physical location**; DO physical location and pre-handler startup phases remain **unknown**. First entry is evidence of a newly observed receiver instance, not proof of a platform cold-start cause.

Run `node scripts/test-latency-browser.mjs` for disposable local controlled acceptance: independent document/enhanced-pane navigations and chat sends, request-root joins, non-streaming Assistant replies with a scripted local provider, pane retention/replacement, eligible hover/no-hover and native immutable-resource cache-hit/network cohorts. It uses real bundled Worker, D1, DOs and Chromium; HTTP caching uses an unrouted loopback bridge preserving product cache headers. Controlled DOM pointer/click dispatch is not human hover behavior. Reports contain aggregate counts/timings only, with unknown location/startup explicit. Local samples establish instrumentation coverage, not real-provider TTFT, production retention/sampling, placement benefit or causal performance improvement.

`npm run test:browser:workbench` exercises every audit view at three widths, checks accepted navigation beacons against captured server points, and explicitly joins pane selection, form submission, input paint and spinner points. Endpoint tests cover exact keys/labels, bounds, auth, tenant pseudonyms and independent session quotas.
