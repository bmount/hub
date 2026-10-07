# Logging: what happened, and who did it

Two records, for two jobs:

| | Request log (Workers Logs) | Audit trail (`event` table in D1) |
| --- | --- | --- |
| What | Every request and every inbound message: path, status, timing, who, the verb, why it failed | Every change, with who and which session; refused sensitive actions (`verb.refused`) |
| Kept | About a week (Workers Logs retention) | As long as the organization exists; part of the product |
| For | "What went wrong at 17:31?", "Is this slow?", abuse | "Who changed this, and when?" |

## The request line

The first middleware in `src/index.ts` writes one JSON line per request with `msg: "request"`. Fields:
- **The request:** `method`, `host`, `path`, `status` and `ms`.
- **The database:** `db` (round trips, statements, ms).
- **Where it came from:** `ray` (the Cloudflare Ray ID; it is also in the browser's response headers), `ip`, `country` and `ua`.
- **Who acted:** `actor` (`id`, `kind`, `email`, plus `root` when they are root), `tenant`, and `auth` (cookie, bearer, token or oauth).
- **What they did:** `via` (api, mcp or playground) and `verb` (an API verb, or `tool:<name>` for MCP and the Playground).
- **What went wrong:** `error` (`reason`, plus `detail` if there is one).

Handlers add facts with `note(request, …)` from `src/log.ts`, and `buildContext` notes the actor on every request.
Status 500 and above logs at error level, 400 and above at warn level, and everything else at info.
Crashes add a separate `msg: "exception"` or `msg: "verb failed"` line with the stack. Inbound mail writes
`msg: "mail"`, with to, from, size, timing and any error.

**Never stored:** Cloudflare's own invocation entries are off, because they record full URLs. Live `tail` still shows full URLs, but it isn't stored. Also never logged: tokens, cookies, request bodies and query values. `/invite/<token>` and `/auth/<token>` become
`/invite/:token` and `/auth/:token`, and a query keeps only its key names (`/docket?owner=…`).

## Looking at logs

- **Dashboard:** Workers & Pages → pimwell-hub → Logs. Filter by `$metadata.message`, or by fields such as
  `actor.email`, `status`, `verb`, `ray`.
- **Live:** `npm run cf -- tail --format pretty`, or `--format json` piped to `jq`.
- **From a Ray ID:** the error page and the `cf-ray` response header carry it. Search the logs for it.

## Who did what, later

- **Changes:** query `event` by `identity_id`, `target_id` or `kind`. Each row has the session, so a change traces
  to one sign-in.
- **Refusals of sensitive actions** (anything needing fresh proof, admin or root): recorded as `verb.refused` with
  who tried, the verb, and the reason.
- **Older than a week:** the request log is gone, but the audit trail remains.
