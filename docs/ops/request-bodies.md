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
budgets: channel forms, assistant/playground/voice and internal
introspection/backlinks/evals. Do not apply a 1 MiB global
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
and pre-read auth/Origin/rate refusals. Authentication-form tests also prove
oversize genuine code/refresh/revoke requests leave grants untouched, a refused
code remains exchangeable, bounded forwarding works with forged framing,
oversize consent cannot approve/deny or consume pending requests, and oversize
login cannot create links or send mail. IP/client ordering, neutral anonymous
consent, exact byte caps, multipart entry routes and safe error text are covered. The full suite guards existing tenant,
mailbox, grant, cookie and login-proof boundaries.
