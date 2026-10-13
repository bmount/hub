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

`site_list` (optionally by project) and `site_read` (by name) are reader-accessible MCP tools and `/api/site.list`, `/api/site.read` verbs. The project sidebar has a Site branch with Performance, Errors and Deploys. Errors and Deploys reuse Apps, with server-side site filtering before list limits and scoped inspector selection. Performance is an empty state pending timing collection and its view.

## Version identity and commit resolution

Each Pimwell Worker declares `version_metadata` as `WORKER_VERSION`, available as `env.WORKER_VERSION.id`, `.tag` and `.timestamp`. It is platform-supplied, requires no secret and adds no resource permission. The release helper permits only this exact additive metadata binding; other binding/runtime changes still fail closed.

Site responses expose each app's latest **recorded production deployment**, its version UUID, deployment UUID, deploy record ID, recording timestamp and supported commit reference/link using the existing deploy-record interpretation. There is no privileged Cloudflare API token in the request path. These records describe the last reported deployment, not an independent live rollout check; an unreported manual deploy or rollback can make them stale. Unknown commits and missing release records remain null, never guessed from abbreviated tags or opaque versions. Release tooling checks Cloudflare's live deployment and records all three Workers, including the tail consumer which has no public route.

## Measurement boundaries

Timing will use Workers Analytics Engine plus Cloudflare tail CPU/wall time, with writes off the response path. Points must be content-free: code-defined route templates, verb/span/interaction names and statement fingerprints, never URL values, queries, titles, bodies, names or addresses. Tenant/person keys are keyed hashes; views must not reveal another organization's name. Measurement must stay below 1 ms CPU overhead per request. Server, browser, synthetic timing and querying are subsequent parts of the site-performance quest; this foundation does not collect timings.
