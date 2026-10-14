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

`site_list` (optionally by project) and `site_read` (by name) are reader-accessible MCP tools and `/api/site.list`, `/api/site.read` verbs. The project sidebar has a Site branch with Performance, Errors and Deploys. Errors and Deploys reuse Apps, with server-side site filtering before list limits and scoped inspector selection. Performance is an empty state pending its view.

## Version identity and commit resolution

Each Pimwell Worker declares `version_metadata` as `WORKER_VERSION`, available as `env.WORKER_VERSION.id`, `.tag` and `.timestamp`. It is platform-supplied, requires no secret and adds no resource permission. The release helper permits the exact additive version metadata binding, `PERF` Analytics Engine binding for `pimwell_perf`, and `PERF_TENANT_KEY` secret. The tail Worker may add only `nodejs_compat`, needed for async-local tracing. Other binding/runtime changes still fail closed.

Site responses expose each app's latest **recorded production deployment**, its version UUID, deployment UUID, deploy record ID, recording timestamp and supported commit reference/link using the existing deploy-record interpretation. There is no privileged Cloudflare API token in the request path. These records describe the last reported deployment, not an independent live rollout check; an unreported manual deploy or rollback can make them stale. Unknown commits and missing release records remain null, never guessed from abbreviated tags or opaque versions. Release tooling checks Cloudflare's live deployment and records all three Workers, including the tail consumer which has no public route.

## Measurement boundaries

The three Pimwell Workers write to Workers Analytics Engine dataset **pimwell_perf**, through optional binding **PERF**. HTTP dispatch, cron, email and tail delivery have root traces. Every verb is wrapped at definition and every page/API route at registration. Durable Object public methods and storage are wrapped once; hibernatable WebSocket messages get independent invocations. No queue consumer is currently configured. KV, R2, service bindings, Artifacts methods, outbound fetch (hostname only), model providers and HTML frame builders have spans.

The `span(name, fn)` tracer in `src/perf.ts` supports synchronous/async functions, nesting, exceptions and concurrent requests through async-local storage. Binding wrappers preserve native receivers, including callable RPC properties. Internal service requests/RPC calls carry a content-free trace envelope; receivers strip it before business handlers execute. Only the service-only Git Worker and namespace-only Durable Objects consume it. Public hub requests never trust a client trace envelope. Child invocations share the request ID and parent span, but use their own version, isolate-cold flag and span ID range. RPC roots have kind **rpc**, so they do not double-count external requests.

D1 statements have a fingerprint of normalized SQL plus a code call site (single-frame capture, bounded isolate caches). Literals/comments never enter exported telemetry. `first` executes `all` once and projects the first row/column to retain metadata; `raw` preserves native semantics and lacks native metadata. `prepare`, `bind`, `batch`, `exec` and sessions retain their behavior. A batch has one trip span plus statement details, each sharing the measured batch wall time with its own D1 metadata; do not sum those detail wall times as independent trips. Native `meta.duration`, rows read/written, region and primary status are retained where D1 supplies them. Wall minus execution is an approximate transport/queue residual, not a pure network measurement.

The Workers clock advances across I/O, not synchronous CPU work. Synchronous render spans can consequently read zero; native invocation CPU is the authoritative CPU measure. Current model providers are non-streaming: first-token time means first decoded text availability, not first network byte.

## Point schema (v1)

Every point uses **index1 = Worker version UUID**. Identity is repeated in blobs so queries need not infer it from the index. Empty tenant/colo mean an unscoped invocation or unavailable platform metadata, never a fabricated tenant/region. Tenant IDs are HMAC-SHA-256 pseudonyms truncated to 128 bits, using the shared **PERF_TENANT_KEY** secret on hub and Git Workers. It grants no authorization. For isolated/local setups without that key, the existing internal/secrets key is a fallback; without any key the tenant dimension is empty. Only completed hash strings are cached: native I/O promises cannot be shared across invocation/DO contexts. Key rotation changes pseudonyms; never expose the key in queries or product responses.

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

`node scripts/perf-catalog.mjs --annotate` maintains neutral `perf-site` SQL comments and generates `src/perfCatalog.ts` from code literals/templates, with file/function/line/column locations. Regenerate it after tracing/query-source changes, repeating until unchanged if several calls share a line. SQL executes with the same bindings and semantics; comments give each prepare call a stable, source-defined identity instead of relying on bundled stack locations. Runtime SQL, interpolated values and bound parameters never enter telemetry. The catalog contains normalized source statements or explicitly labeled source templates/expressions, never substituted user values. Literal-only legacy queries may have several candidate sites; new annotated points carry their exact site. Blob 19 on server points holds a source-defined location; blob 20 holds the SQL catalog key (the per-call-site fingerprint remains blob 15). Dynamic binding spans link to their instrumentation function when a business call site is unavailable. Client blob 19 retains its previous-route meaning; client blob 20 links to the collector.

Server points with double 20 = 2 add double 15 (start offset from invocation), double 16 (approximate epoch start in milliseconds), and double 17 (exclusive wall time after the union of child intervals). D1 batch statement details do not subtract from or multiply their shared trip. Older points lack these fields and must not be shown as zero-duration breakdowns. Siblings may overlap; exclusive spans describe attributed work, not an additive critical path across concurrent branches. Internal invocations use their own epoch clock, so cross-isolate waterfalls have clock-resolution uncertainty.

## Sampling and SQL

All requests are submitted; Analytics Engine can downsample on ingestion/query. **Always weight counts, means and distributions with `_sample_interval`**. Do not use raw `COUNT(*)` as a traffic total. An individual trace can lose its root or parent points to sampling; missing points are not zero time or proof of failed emission. Filter kind `request` for external/event requests, `rpc` for internal roots, and `invocation` for native CPU. Filter by site/authorized tenant hash before exposing aggregates through the product; account-level SQL access alone is not product authorization.

Example version query (replace the UUID; Cloudflare Analytics Engine SQL API):

```sql
SELECT blob2 AS worker, blob7 AS kind, blob8 AS route,
       SUM(_sample_interval) AS represented_points,
       SUM(double1 * _sample_interval) / SUM(_sample_interval) AS mean_wall_ms
FROM pimwell_perf
WHERE index1 = 'worker-version-uuid'
GROUP BY worker, kind, route
ORDER BY represented_points DESC
```

Native CPU for the same version:

```sql
SELECT blob2 AS worker,
       SUM(double12 * _sample_interval) / SUM(_sample_interval) AS mean_cpu_ms,
       SUM(double13 * _sample_interval) / SUM(_sample_interval) AS mean_native_wall_ms
FROM pimwell_perf
WHERE index1 = 'worker-version-uuid' AND blob7 = 'invocation'
  AND double12 >= 0
GROUP BY worker
```

Guardrails in `test/perf-budget.test.ts` enumerate every registered route, verb and public Durable Object method, assert actual span emission, cover both scheduled handlers, exercise page/API/MCP/git/chat collection and check content/credential exclusion, nesting, failures, D1 metadata and the cap. The existing deadline tests ensure tracing does not change cancellation/timer behavior. `node scripts/perf-overhead.mjs` measures warmed CPU-only overhead against fake I/O at ordinary, capped and overflowing span counts; the host suite asserts <1 ms. This isolates tracer/serialization cost and explicitly excludes native Analytics Engine ingestion; live native invocation CPU provides the production cross-check. Browser collection is described below; synthetic collection and authorized product querying are separate quest items.

## Browser timing

The signed-in frame loads a content-hashed collector before its deferred pane clients. Existing `/client/slow` error grouping is unchanged. `POST /client/timing` accepts only a same-origin browser-cookie session (and tenant membership on tenant hosts); it accepts no client-supplied tenant, version, identity or source. Apex account pages use an empty tenant dimension. The existing KV limiter allows 120 batches/minute **per session**, not per identity; its eventual-consistency limits apply here too. Each request is bounded to 32 KiB and 100 points. The client keeps at most 300 unsent points, drains batches of 100 with `sendBeacon` on pagehide/hidden visibility, and also drains at the high-water mark. Delivery is best-effort and never blocks or retries product writes.

Every point has six required keys: `path`, `previous` (route templates), `name`, `phase` (fixed labels), `request` (server UUID) and `duration` (finite 0–3,600,000). New collectors add optional `at`, the browser's epoch start timestamp, bounded to within 24 hours of receipt. Legacy six-key batches remain accepted. Browser clocks are untrusted; timestamps give waterfall position, not proof of server ordering. No URL queries, project/channel/person names, text, selectors, form fields or message contents enter the wire format. Navigation response `Server-Timing: request;desc="<UUID>"` mirrors `X-Request-ID` so Navigation Timing can read it without an extra fetch. Enhanced fetches use `X-Request-ID`; their paint/fetch/indicator points join that response. Input-only work, aborted/unacknowledged waits and responses without readable headers retain the initiating page's server ID, **not an invented ID for an unseen response**. Client IDs/measurements are untrusted observations; join server data by authorized tenant as well as request ID.

### Fixed allowlists

Markup is marked `data-perf`; the collector supplies fixed defaults for native forms, table rows, links, inline inspector disclosures and search inputs, including replacement panes. Assistant and chat composers carry explicit names. Only the following names are accepted:

- Page: `navigation`, `network`, `render`, `dns`, `connect`, `tls`, `ttfb`, `response`, `dom.interactive`, `load`, `lcp`, `cls`, `longtask`.
- Interaction: `list.select`, `docket.select`, `pane.swap`, `form.submit`, `inspector.open`, `chat.send`, `assistant.send`, `search`.
- Live/voice: `chat.connect`, `chat.reconnect`, `presence.connect`, `presence.reconnect`, `assistant.first-token`, `voice.transcribe`, `voice.correct`.
- Phases: `page`, `paint`, `fetch`, `spinner`, `connection`, `first-token`.
- Routes: `/`, `/docket`, `/people`, `/apps`, `/jump`, `/search`, `/assistant`, `/assistant/tools`, `/assistant/chat`, `/do`, `/new`, `/attention`, `/mail`, `/mail/:message`, `/mail/recipients`, `/c`, `/c/:channel`, `/c/:channel/t/:number`, `/inbox`, `/usage`, `/situations`, `/archive`, `/skills`, `/skills/:skill`, `/projects/new`, `/me`, `/me/sessions`, `/admin/:section`, `/people/:person`, `/:project`, `/:project/docket`, `/:project/w/:number`, `/:project/graph`, `/:project/frontier`, `/:project/board`, `/:project/status`, `/:project/code`, `/:project/files`, `/:project/reviews`, `/:project/reviews/:number`, `/:project/wiki`, `/:project/wiki/:slug`, `/:project/documents`, `/:project/contacts`, `/:project/contacts/:entity`, `/api/:verb`, `/voice/:operation`, `/chat/v1/ws`, `/other`.

`src/clientTiming.ts` is the shared server/browser vocabulary. New labels must be added there and here, never inferred from visible/user text.

### Interpretation and joins

Client points reuse the v1 identity columns and `double1` for the measurement. For kind `client`, **blob8** is the client route template, **blob9** is the phase, **blob14** is the allowlisted name, and **blob19** is the previous route template. **blob6** is the joined server request ID, never the beacon POST's ID. New client points have double 16 = browser epoch start and double 20 = 2; older clients omit them. `double10` also holds first-token availability for `first-token` points; other server-only fields retain their unavailable/default values. Version/colo describe the receiving hub invocation; a delayed beacon can cross a deployment boundary, so use the joined server point for the origin response's version/colo. Never sum overlapping phases or shared chat/presence measurements.

DNS/connect/TLS/TTFB/response are Navigation Timing differences. `network` spans navigation start to response end (including server time); `render` spans response end to load readiness (including subresources and browser work). Joined network residuals subtract the matching server root, never add TTFB to an already complete fetch duration. DOM interactive and load are offsets from navigation start. LCP is the latest available candidate offset; CLS is unitless (the maximum session window: 1 s gaps, 5 s maximum), not milliseconds. Vitals belong to the original document/server ID even after enhanced pane changes. CLS/LCP snapshots may be sent again after visibility resumes; use their maximum per document request, not their sum. Long tasks are individual durations where supported. Unsupported observer APIs omit those measurements rather than report a fabricated zero.

Input-to-next-paint uses Event Timing where available (16 ms threshold), otherwise a task after requestAnimationFrame. Pane readiness uses the same post-frame fallback, from the initiating fetch start. Native same-origin links/forms carry only an allowlisted action and bounded timestamp across navigation in sessionStorage, joining the destination document's ID; their fetch duration is navigation responseEnd. BFCache restoration has zero network duration and reuses its document's server ID. Enhanced navigation separately records fetch/body/render completion, the progress cursor's visible wait, and the new route plus previous template. Inline submit controls, Assistant thinking dots, live chat send controls and voice busy indicators also record their waits and triggering action. An aborted wait without a response can only join its initiating document.

Chat and socket presence share one authenticated WebSocket. Its first `connected` frame carries the upgrade's server request ID (also in the response header); connect/reconnect points measure attempt-to-authenticated-readiness, excluding reconnect backoff. Chat command acknowledgements carry their server invocation ID for send/indicator joins, distinct from the client's command correlation ID. The current Assistant is non-streaming: first-token means first decoded reply text availability, not first transport byte. Telemetry does not clone/consume extra response bodies or alter cancellation deadlines.

`npm run test:browser:workbench` exercises every audit view at three widths, checks accepted navigation beacons against captured server points, and explicitly joins pane selection, form submission, input paint and spinner points. Endpoint tests cover exact keys/labels, bounds, auth, tenant pseudonyms and independent session quotas.
