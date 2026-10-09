# Model call deadlines (#110)

## Released increment contract

All current OpenAI provider operations (`verify`, `ask`, assistant `turn`, and
`transcribe`) use one **30,000 ms** budget starting immediately before transport.
It covers response headers, streamed success/error bodies, UTF-8 decoding and
JSON parsing. It is not a per-chunk inactivity allowance. Checks use the larger
of elapsed wall and monotonic time, including checks before/after every body
read and after parsing. Delayed timers and sleep-paused monotonic clocks cannot
authorize late headers, chunks, EOF or decoded results. Forward wall-clock jumps
conservatively expire early; wall rollback cannot extend a running monotonic
budget.

Response bodies are capped at **4 MiB actual streamed bytes**, before JSON
parsing. Content-Length is only an early rejection hint, not an authorization
for actual bytes. Invalid UTF-8/JSON on a successful response is an error; an
unparseable error response retains its HTTP-status fallback without retaining
its raw body. These are provider-response limits, independent of HTTP inbound
request limits and voice-upload allowances.

Each operation gets its own AbortController. Optional caller cancellation is
propagated to transport; assistant chat and voice HTTP handlers pass the request
signal. Timeout/cancellation independently rejects even when transport ignores
abort. Cleanup is best effort and nonblocking, including late headers and
stalled cancellation. No provider request is automatically retried.

`ask`/transcription record one failed ledger entry with **unknown tokens**, not
zero spend or a fabricated provider rejection, and return `504 provider_timeout`
or `408 provider_cancelled`. Assistant provider timeout/cancellation uses the
same status and explicitly warns that earlier tool changes are not rolled back.
Late model output is never offered to the tool executor. Successful observed
usage remains metered normally. Timeout messages contain no prompts, response
bodies, keys or invented usage values.

## Acceptance evidence

Implementation paths: `src/models/deadline.ts`, `src/models/providers.ts`,
`src/models/ask.ts`, `src/assistant/run.ts`, and assistant/voice HTTP handlers.

- `npm run typecheck` passes.
- Default full `npm test` passes **1,529 tests / 165 files** on the implementation
  base `0765b4e`; poisoned-Inbox exception logs are deliberate isolation fixtures.
- `test/model-deadline.test.ts`: all four provider methods with indefinitely held
  headers ignoring abort; late-header body cleanup without retry; success and
  401/429/500 stalled streamed bodies; same headers/body budget with success at
  29,999 ms; exact 30s wall-only overdue headers/body/error with timers not
  dispatched; continuous fulfilled chunks reaching the monotonic budget;
  pre-abort/headers/body cancellation; cleanup and later abort after success;
  declared/actual response overflow including understated Content-Length;
  failed unknown-usage ledger entry and truthful 504.
- `test/assistant.test.ts`: disposable authenticated local HTTP chat with a
  fixture model returning a tool request after controlled 30s wall-time advance
  returns 504, records exactly one failed unknown-usage entry and executes no
  late tool. No assistant answer is claimed/persisted. Existing conversation
  history, identity isolation, scopes, CSRF and safe rendering tests pass.
- Existing models, voice, tenant/grant and mail/auth regression suites pass.

Tests use synthetic keys and controlled transport/clocks; they are not live
provider latency, native system-sleep, actual cost or production-user acceptance.
The initial streamed decoder typecheck required the Workers TextDecoder
`ignoreBOM` option; fixed without weakening validation. Only the subsequent
passing typecheck/full run is acceptance evidence. Release/rollback IDs belong
in #110's milestone and production record after ordinary main integration and
the managed helper's independent rollout/smoke verification.

## Still open (not a completed #110)

- Whole assistant-turn budget spanning database work, all model rounds and tools.
  Existing caps remain eight model rounds/six tools per round; the new 30s
  provider budget does not limit the entire turn.
- Tool cancellation and durable interrupted-turn progress/resumability. An
  already executing write may finish despite request cancellation; neither
  abort nor timeout proves it did not execute. Do not blindly retry ambiguous
  writes or imply rollback. Failed turns currently do not persist transcript or
  resumable steps; this increment only reports the uncertainty truthfully.
- Database/key-decryption deadlines, long-running job semantics and streamed
  progress. These are not covered by the transport budget.
- Observed p95/timeout/abandoned-spend reporting and live controlled provider
  acceptance. Unknown timeout token/cost values must remain unknown.
- Native #132 BFCache/freeze acceptance still needs its documented supported
  engine/headed display fixture. Nothing here changes presence or private
  no-store headers.

No credential creation, real membership changes, schema/data migration,
scheduler/runner changes, privacy-header weakening or grant/authentication
changes are part of this increment.
