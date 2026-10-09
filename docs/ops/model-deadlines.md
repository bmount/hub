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

## Whole assistant-turn budget increment

`src/assistant/deadline.ts` and `src/assistant/run.ts` now apply a single
**60,000 ms** budget starting at `runTurn`, before route lookup. It spans route
and credential lookup, key decryption, history reads, all model rounds, usage
writes, tool calls and final transcript batch. HTTP authentication, request-body
reading and thread selection/creation precede `runTurn` and retain their own
contracts; this is not a deadline for the entire HTTP handler.

Each awaited operation is raced separately, with max(wall, monotonic) checks
before starting and after settling. An ignored abort can release the caller
without leaving a detached assistant loop running: a late route/model/tool/DB
result cannot start the next effect. The turn signal propagates to provider
transport alongside its existing 30s per-call budget. Exact-boundary delayed
success/error is rejected even without timer dispatch; wall rollback cannot
extend the monotonic budget. Timer/listener cleanup does not abort completed
turns. Existing eight-round/six-tool caps and permission checks are unchanged.

Whole-turn failure returns `504 assistant_timeout` or `408 assistant_cancelled`,
with the existing thread reference and an explicit warning that already-started
tool **or transcript** changes may still complete, are not rolled back, and
must be checked before retrying. D1 and tools do not expose cancellation here;
we stop waiting and gate follow-on work, not undo in-flight effects. An
already-submitted transcript batch may finish even though no answer is returned.
Nothing automatically retries/resumes a failed turn or claims durable progress.

Successfully observed model usage is metered before tool execution, under the
same budget. Existing provider failures are metered with unknown tokens when
there is time left. Whole-turn expiry deliberately starts **no new ledger
write**: an already-running write may complete, but the interrupted call may
have no ledger entry. This coverage gap is not zero spend or verified provider
failure and requires future durable accounting/reconciliation. No raw prompts,
tool results, credentials or invented usage appear in timeout telemetry.

Acceptance for this increment:

- `test/assistant-turn-deadline.test.ts`: stalled route/credential/decryption/
  history/usage/tool/transcript phases, ignored abort and late completion with
  no continuation; multi-round wall-only expiry; exact-boundary model/tool/
  transcript success; pre/model/tool caller cancellation; successful persistence
  at 59,999ms; cleanup after later caller abort; monotonic expiry with wall
  rollback and deadline precedence over obsolete errors.
- `test/assistant.test.ts`: disposable authenticated HTTP turn with three
  individually timely 20s model rounds returns truthful 504 at 60s, only two
  tool calls and observed usage entries, no expired third tool or transcript.
  Against `dfb236c`, the same regression fails: HTTP 200 after 160s, rather than
  504. Existing provider-timeout/unknown-token behavior and isolation/scopes/
  CSRF/history/rendering checks remain passing.
- Typecheck and targeted suite pass (43 before the additional late-DB-error
  regression); final default full suite passes **1,708 tests / 175 files**.
  Initial full run was interrupted by the command harness's 120s limit, not a
  test assertion; unmodified complete rerun passed in 145s. Expected poisoned
  Inbox exceptions are intentional isolation fixtures.
  Initial use of unsupported module mocks
  caused fixture errors; switched to established module spies without changing
  product behavior/assertions. That failed probe is not acceptance evidence.
- Managed-release evidence is recorded in #110 after independent validation.
  Controlled clocks/mocked waits and local synthetic-authenticated HTTP tests
  are not native sleep, real provider latency, production-user or cost proof.

## Still open (not a completed #110)
- Tool cancellation and durable interrupted-turn progress/resumability. An
  already executing write may finish despite request cancellation; neither
  abort nor timeout proves it did not execute. Do not blindly retry ambiguous
  writes or imply rollback. Failed turns currently do not persist transcript or
  resumable steps; this increment only reports the uncertainty truthfully.
- Actual database/tool cancellation, long-running job semantics and streamed
  progress. The turn budget bounds waiting, not in-flight operation completion.
- Durable accounting of whole-turn interruptions, including missing model-call
  entries when expiry prevents starting a ledger write.
- Observed p95/timeout/abandoned-spend reporting and live controlled provider
  acceptance. Unknown timeout token/cost values must remain unknown.
- Native #132 BFCache/freeze acceptance still needs its documented supported
  engine/headed display fixture. Nothing here changes presence or private
  no-store headers.

No credential creation, real membership changes, schema/data migration,
scheduler/runner changes, privacy-header weakening or grant/authentication
changes are part of this increment.
