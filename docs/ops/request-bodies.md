# Request body bounds (#102)

## Implemented first increment

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

Oversized requests return 413 without running verbs, creating clients or
executing tools. API form refusals render an inert readable page. Stream errors
or request cancellation return safe 400 errors without reflecting arbitrary
stream exceptions. Cancellation is best-effort and never delays a refusal;
reader locks/listeners are released. Buffer growth is bounded, copies source
chunks immediately, and stores no unbounded per-chunk list. Downstream form/SDK
requests are rebuilt only from bounded bytes; forged length/transfer framing
headers are removed. Original requests remain the authentication/logging source.

## Remaining work and limits

This increment does **not** complete #102 across every route. Separate browser,
internal and OAuth-token parsers still need this utility with suitable endpoint
budgets: login/consent/channel forms, assistant/playground/voice, internal
introspection/backlinks/evals, and OAuth token/revoke. Do not apply a 1 MiB global
middleware cap to Git smart HTTP forwarded to Ardi or voice uploads with their
separate recording allowance. Incoming mail uses its separate original-byte cap.

No body deadline is introduced here: an under-limit stalled stream can still
wait until client/platform cancellation. Whole-request read deadlines and
pre-credential API abuse controls are separate followups; this increment puts
rate/auth refusals before parsing without claiming protection against every
credential-validation load. No schema, membership, consent or infrastructure
changes are needed.

Native-Workers tests cover chunked absent/forged lengths, exact limits, UTF-8,
URL-encoded/multipart forms, source-owned chunk mutation, tiny chunks, aborted or
erroring streams, stalled cancellation, actual Worker routing, MCP valid parse
reuse/malformed JSON/batches/media validation, both authenticated MCP endpoints,
and pre-read auth/Origin/rate refusals. The full suite guards existing tenant,
mailbox, grant, cookie and login-proof boundaries.
