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
| 7 | Kind: `request`, `rpc`, `span`, `other`, `invocation` |
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

Guardrails in `test/perf-budget.test.ts` enumerate every registered route, verb and public Durable Object method, assert actual span emission, cover both scheduled handlers, exercise page/API/MCP/git/chat collection and check content/credential exclusion, nesting, failures, D1 metadata and the cap. The existing deadline tests ensure tracing does not change cancellation/timer behavior. `node scripts/perf-overhead.mjs` measures warmed CPU-only overhead against fake I/O at ordinary, capped and overflowing span counts; the host suite asserts <1 ms. This isolates tracer/serialization cost and explicitly excludes native Analytics Engine ingestion; live native invocation CPU provides the production cross-check. Browser, synthetic collection and authorized product querying are separate quest items.
