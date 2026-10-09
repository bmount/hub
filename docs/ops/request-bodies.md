# Request body bounds (#102)

## Implemented bounds

`src/http/body.ts` caps **actual streamed bytes before parsing**. Content-Length
can reject an obviously oversized request early, but a missing, malformed, zero
or understated length never bypasses the streamed cap. Byte limits include UTF-8
and multipart framing, not decoded character counts or just uploaded file size.

- `/api/*`: 1 MiB for JSON, URL-encoded and multipart forms (also unrecognized
  content types). Host, credential, scope, cookie Origin and access checks happen
  before reading. Anonymous callers of public verbs take the existing KV-style
  IP rate check (60/minute, hashed subjects); a forged credential does not exempt
  a caller who fails authentication. This is eventually consistent throttling,
  **not** an atomic hard quota. Authenticated callers keep existing verb controls.
- `/mcp` and `/agent/mcp`: 1 MiB after the existing host, Origin, authentication
  and rate checks. Denied callers' bodies are not parsed. One successful JSON
  parse supplies logging metadata, batch rejection and the SDK's documented
  `parsedBody` option; no body-clone parsing is used. SDK protocol/schema/media
  validation still runs. Malformed JSON goes through the bounded SDK parse-error
  path instead. The same cap is also set on the SDK as defense in depth.
- `/oauth/register`: the existing 8 KiB cap is now applied while streaming,
  after the existing IP/global registration rate checks. Redirect allowlists,
  public-client policy, OAuth library behavior and audit remain unchanged.
- `/oauth/token` and `/oauth/revoke`: 16 KiB for URL-encoded credential forms.
  Apex/media checks and the existing hashed-IP 120/minute gate precede all body
  reads. The existing 60/minute client gate follows bounded parsing, before any
  code exchange, refresh rotation or revocation. Overflow returns OAuth
  `invalid_request` with 413; read errors/aborts return the same safe error with
  400. Forwarded bounded form text drops untrusted length/transfer framing. No
  token/grant mutation occurs on a body refusal.
- `POST /login`: 16 KiB including multipart framing. Apex/Origin checks and a
  separate hashed-IP 60/minute ingress gate precede parsing. It does not increase
  the existing fail-closed email address/IP send quotas, restore withdrawn
  consent, or change neutral address-known/unknown responses. Ingress throttling
  is address-independent and returns an inert 429 with Retry-After; oversized
  forms return inert 413 and stream errors/aborts return 400, with no sign-in
  link creation or send. This new KV gate is eventually consistent, not an
  atomic hard quota; rate-storage read failure cannot proceed to a send.
- `POST /oauth/consent/:id`: 16 KiB including multipart framing. Apex/Origin,
  syntactic pending-id and browser authentication denials precede reading.
  Overflow/read refusal returns inert 413/400 without approving, denying,
  deleting the pending request or recording a consent decision. Bounded forms
  still require the exact session-bound form token; fresh-proof, tenant
  membership, single-use and redirect controls remain in the original decision
  path. A body refusal is not authorization to approve or release anything.

- `POST /c/:slug` and `/c/:slug/t/:seq`: 64 KiB for channel compose forms,
  including URL-encoded/multipart framing and ignored fields. Tenant browser
  authentication, same-Origin and minimum member role denials precede reads.
  Overflow/read refusal returns inert 413/400, without posting, changing a
  channel head or sending a reply. The original verb's channel membership,
  stale-view and 8 KiB **message byte** checks still apply after parsing. The
  envelope cap accommodates a full URL-encoded Unicode message; it is not a
  larger message allowance. Channel per-verb rate checks remain downstream.
- `POST /assistant/chat`: 64 KiB actual bytes before JSON parsing, after the
  existing own-browser/session, tenant, Origin, custom-header/media and
  identity rate gates. The original 20,000 decoded envelope-character and
  8,000 message-character checks still apply. Overflow/read refusal returns
  safe 413/400 before thread creation, scope switching, model calls, tool
  dispatch or conversation storage. A full 8,000-character Unicode message
  remains supported.
- `POST /playground/call`: 64 KiB actual bytes before JSON parsing, after the
  existing own-browser, tenant, Origin, custom-header/media and session rate
  gates. Unlike the previous decoded-character cap, this counts UTF-8 bytes:
  multi-byte tool envelopes may now be refused sooner. Overflow/read refusal
  returns safe 413/400 with no tool execution or `playground.call` audit. Scope,
  role, grant and tool exposure checks are unchanged. These existing rate
  gates are eventually consistent, not atomic hard quotas.

- `POST /internal/introspect` and `/internal/backlinks`: 16 KiB actual bytes
  before JSON parsing. The existing service-binding secret check and public
  `cf-connecting-ip` disqualification precede reading, regardless of declared
  length. Overflow returns an inert, non-echoing `{ ok: false }` with 413;
  read errors/aborts return the same body with 400. Malformed bounded JSON
  preserves the existing neutral 200/`ok: false` behavior. Refused bodies do not
  look up sessions/principals, touch Git session activity or query backlinks.
  Tenant, principal, operator and credential policy remains unchanged. This
  cap applies to the small hub envelopes, **not** Ardi Git pack bodies.
- `POST /internal/evals/intent`: 64 KiB actual bytes before JSON parsing,
  after the existing apex/configured-key/bearer and 10/hour run-rate gates.
  Overflow returns safe 413; read errors/aborts return safe 400, without
  attribution lookup, model calls, usage or `eval.run` audit. Bounded JSON
  must be an object (null/arrays/scalars now receive 400 instead of permitting
  a null property-access exception). Valid input keeps the 60-case limit,
  named active-agent attribution, tenant-bound project lookup and model audit.
  The existing KV run gate is eventually consistent, not an atomic hard quota.

- `POST /voice/transcribe`: 15 MiB + 64 KiB actual bytes before multipart
  parsing. The separate **audio file** limit remains 15 MiB; the additional
  allowance bounds multipart headers, context and ignored fields without
  excluding a full-size recording. It is not an increased audio allowance.
  Own human browser, active tenant membership (on a tenant host), same-Origin,
  voice custom-header and identity-rate denials precede reading. Overflow
  returns inert 413; read errors/aborts or malformed forms return safe 400.
  Refused requests perform no vocabulary lookup, transcription, model usage
  write or audio/transcript storage. Existing audio format checks remain.
- `POST /voice/correct`: 128 KiB actual bytes before JSON parsing, after the
  same voice guards and JSON-media check. This accommodates the existing
  40,000 UTF-16-unit envelope in UTF-8; the original 40,000-unit envelope and
  10,000-unit transcript limits remain. Context is still clipped as before.
  Overflow returns inert 413; read errors/aborts and malformed input return
  safe 400. JSON must be an object (null, scalars and arrays no longer reach
  property access). Refused requests perform no vocabulary lookup, model
  correction or usage/storage effects. Voice rate controls remain eventually
  consistent, not an atomic hard quota. Neither endpoint stores recordings
  or transcripts; these caps do not authorize sending a message.

Oversized requests return 413 without running verbs, creating clients or
executing tools. API form refusals render an inert readable page. Stream errors
or request cancellation return safe 400 errors without reflecting arbitrary
stream exceptions. Whole-original-body read expiration returns safe 408 errors
before parsing or executing the request; it never substitutes an empty form. Cancellation is best-effort and never delays a refusal;
reader locks/listeners are released. Buffer growth is bounded, copies source
chunks immediately, and stores no unbounded per-chunk list. Downstream form/SDK
requests are rebuilt only from bounded bytes; forged length/transfer framing
headers are removed. Original requests remain the authentication/logging source.

## Whole-original-body deadlines

All of the above bounded readers use one ten-second budget from the start of
body reading through EOF and owned-buffer assembly. `/voice/transcribe` uses a
separate sixty-second budget to accommodate its 15 MiB recording allowance;
voice correction retains ten seconds. These are whole-read budgets, not timers
reset by each chunk or an inactivity timeout. Existing authentication, Origin,
media and rate refusals still precede establishing the body timer.

A timer rejects a pending read even if the producer or its cancellation never
settles. Monotonic checks also refuse late chunks (including empty chunks), EOF
and assembly when timer dispatch is delayed. Cancellation is best-effort;
locks, abort listeners and timers are cleaned on success and every refusal.
Only the current pending read retains a failure callback; repeated tiny chunks
do not accumulate reactions on an unresolved shared abort promise. Complete
bytes arriving just inside the budget still use the existing parsers and
semantic/decoded limits. An expired request cannot exchange/revoke a grant,
consume/approve a pending consent, create a sign-in link/send mail, post a
message or dispatch a model/tool. Prior rate accounting is not undone; normal
safe refusal telemetry remains. OAuth endpoints preserve their protocol error
bodies with HTTP 408, internal service refusals remain `{ ok: false }`, and voice
reports `request_timeout`. Clients must not treat any transport error as a
blanket authorization to replay unrelated writes.

This is **not** a total request/credential/D1/model/tool/SDK/form-parsing deadline.
JavaScript cannot preempt synchronous blocking work; monotonic checkpoints
refuse late results when control returns. The budgets start after pre-read gates,
not at network arrival. Git smart HTTP forwarding and independent incoming-mail
read budgets are unchanged. No automatic retry/resend or background job is added.

## Remaining work and limits

This increment does **not** complete every #102 abuse/deadline requirement.
The identified API/MCP, browser, OAuth, internal and voice parsers now have
endpoint budgets. Do not apply a 1 MiB global middleware cap to Git smart HTTP
forwarded to Ardi or voice uploads with their separate recording allowance.
Incoming mail uses its separate original-byte cap.

Original-body read deadlines are now enforced as described above. Total-handler
and downstream-provider deadlines and pre-credential API abuse controls remain
separate followups; this increment puts rate/auth refusals before parsing without
claiming protection against every credential-validation load. No schema, membership, consent or infrastructure
changes are needed.

Native-Workers tests cover chunked absent/forged lengths, exact limits, UTF-8,
URL-encoded/multipart forms, source-owned chunk mutation, tiny chunks, aborted or
erroring streams, stalled cancellation, actual Worker routing, MCP valid parse
reuse/malformed JSON/batches/media validation, both authenticated MCP endpoints,
and pre-read auth/Origin/rate refusals. Authentication-form tests also prove
oversize genuine code/refresh/revoke requests leave grants untouched, a refused
code remains exchangeable, bounded forwarding works with forged framing,
oversize consent cannot approve/deny or consume pending requests, and oversize
login cannot create links or send mail. IP/client ordering, neutral anonymous
consent, exact byte caps, multipart entry routes and safe error text are covered. Browser chat tests additionally cover chunked/forged framing across all three
handlers and production entry routes, full Unicode messages, exact byte caps,
malformed input, ignored field overflow, multipart framing, stalled cancel,
read errors/aborts and pre-read auth/Origin/header/media/role/rate denials.
Refused Assistant scope changes leave the existing thread unchanged; refused
Playground write intents create no work, tool audit or model calls; refused
channel/thread drafts leave the head unchanged. Internal ingress tests cover
actual production entry routes, exact valid byte caps, forged/absent length,
UTF-8 overflow, stalled cancellation, safe read/abort errors, malformed
objects, pre-read service-secret/public-IP and eval host/key/rate denials.
Refused bodies perform no D1 credential/principal lookups or activity/model
writes; valid capped eval input still records attributed model usage and audit.
Voice ingress tests additionally cover actual production overflow routing,
full 15 MiB audio at the exact envelope cap, oversized files inside bounded
multipart, ignored fields, full Unicode transcripts at the original decoded
limit, exact byte limits, malformed JSON objects/forms, no-pull auth/tenant/
Origin/header/media/rate denials, forged/absent framing, UTF-8, read errors/
aborts and stalled cancellation. Refusals leave model calls, usage ledger,
conversation storage and events untouched. Valid calls still record usage;
no real provider invocation is needed for these native-Workers fixtures.
Whole-read regressions additionally cover empty/partial/full-without-EOF stalls,
one budget across chunks, continuously fulfilled and empty chunks, late EOF/
assembly before timer dispatch, cancellation errors/stalls, cleanup, abort/size/
source-error precedence, and successful bytes just inside both budgets. Actual
production router tests refuse late bytes across API JSON/forms, MCP, OAuth
registration/token/revoke/consent/login, browser chat/Assistant/Playground,
internal service/eval and voice routes without grant/pending/work/conversation/
model/send effects; timer-driven stalls are covered for API/MCP/voice recording.
The full suite guards existing tenant, mailbox, grant, cookie and login-proof
boundaries.
