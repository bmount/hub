# Logging: what happened, and who did it

Two records, for two jobs:

| | Request log (Workers Logs) | Audit trail (`event` table in D1) |
| --- | --- | --- |
| What | Content-safe error labels, exception types, request counts and deploy metadata in Pimwell | Every change, with who and which session; refused sensitive actions (`verb.refused`) |
| Kept | Raw Workers Logs persistence is off; redacted events are stored in Pimwell | As long as the organization exists; part of the product |
| For | "What went wrong at 17:31?", "Is this slow?", abuse | "Who changed this, and when?" |

## The request line

The first middleware in `src/index.ts` emits only `msg: "request"`, `status`, `ms` and bounded database timing/counts. `note` still supplies internal request context, but `emit` deliberately excludes paths, query names, user agents, identity fields and error details. Stack traces and dynamic exception messages are not explicitly logged. Status 500 and above logs at error level, 400 and above at warn level, and everything else at info.

Workers Observability is enabled at full sampling on every Pimwell and AgentFeed Worker. Invocation logs and raw log persistence are disabled: native exceptions may contain provider text or user data. The ephemeral Cloudflare tail stream still carries raw URLs/exceptions, so never archive or paste it. `pimwell-tail` replaces arbitrary URL paths/query names, exception messages and log strings before sending anything to the hub over the `Ingest` service binding. Only fixed operational labels, standard exception types, counts, Ray IDs, Worker/version identifiers and hexadecimal commit tags cross this boundary. Structured AI usage accepts known model/provider names and numeric usage only; arbitrary purposes are discarded.

The hub and Git proxy and all seven AgentFeed Workers name `pimwell-tail` as their consumer. The tail itself has Observability enabled but no self-consumer: recursively tailing delivery would create a feedback loop. It logs only a fixed delivery-failure label and batch count, and never retries an ambiguous send. Source-to-project registration supplies the app identity. Releases tag versions with the full commit and record each Worker rollout; deploy commands use the individual Worker config so non-versioned observability/consumer settings are synchronized too.

## End-to-end check

An authenticated, authorized `POST /api/project.status` with header `x-pimwell-telemetry-probe: exception` schedules the fixed `Pimwell telemetry test exception` after a successful status read. The normal response is unchanged; anonymous, refused or failed reads cannot induce it. Inspect `app.errors` / `app.error` and `project.status` for delivery and source coverage. Never use actual user content for a probe.

## Confirmed-empty tool polling (#99 increment)

MCP (human and agent) and Playground calls normally record `mcp.call` / `playground.call` activity.
Four query verbs opt in to an exception through typed `quietPoll` metadata: `mail.list`, `attention.list`,
`chat.inbox`, and `chat.catchup`. Only a successfully run **and rendered**, confirmed-empty result skips that
D1 activity event. It emits a debug line with `msg: "mcp.poll"`, transport, fixed verb name and `outcome: "empty"`.
No arguments, results, cursors, message bodies or mailbox identifiers go in that line.

Nonempty results, compact catch-up summaries (`quiet`), omitted coverage, inbox continuation pages, and
catch-up cursor advancement retain normal activity auditing. Commands never qualify. A missing/invalid
result or failing classifier defaults to normal auditing. All tool failures and denials retain their existing
D1 audit; authorization and current mailbox/channel/grant checks still precede classification. Polling never
acknowledges attention or advances read cursors. Existing authentication/session health touches are unchanged
and coalesced; debug output is not durable processing or execution proof.

This increment removes empty-tool event inflation, not all polling noise: generic HTTP request lines still
log at their usual status-based levels, other queries still audit, and repeated *nonempty* reads are not
silently deduplicated. API/UI polling and externally managed runner logging have not been demoted here.
This is intentionally narrower than changing request middleware or weakening the audit of writes/failures.
The prior all-calls audit design is qualified only by this explicit empty-query exception.

## Looking at logs

- **Pimwell:** Apps (`/apps`), `app.errors`, `app.error`, and `project.status` show content-safe errors and coverage.
- **Cloudflare:** Observability is enabled, but raw Workers Logs are not persisted. Do not use raw tail captures as an archive.
- **From a Ray ID:** the error page and the `cf-ray` response header carry it; forwarded error examples retain the Ray ID.

## Who did what, later

- **Changes:** query `event` by `identity_id`, `target_id` or `kind`. Each row has the session, so a change traces
  to one sign-in.
- **Refusals of sensitive actions** (anything needing fresh proof, admin or root): recorded as `verb.refused` with
  who tried, the verb, and the reason.
- **Older than a week:** the request log is gone, but the audit trail remains.
