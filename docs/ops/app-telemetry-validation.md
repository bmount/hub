# Bounded RPC telemetry validation (#107)

## Increment scope

`Ingest.events` delegates to `ingest`, which now validates and copies a bounded allowlisted event directory **before any SQL**. A service binding authenticates a calling service, not every nested payload. Malformed nested logs, exceptions or usage drop the entire event; valid siblings may proceed. Unknown fields are rejected, not retained or logged. Validation adds no raw prompts or tool output to telemetry.

- At most the first **500 original inputs** are considered. Excess inputs are dropped, not omitted from accounting. `accepted + dropped` equals the original array length on successful ingestion, including malformed and unapproved inputs. Non-array input still returns zero/zero.
- Validate nullable scalar types, finite safe integer timestamps, HTTP statuses, bounded text, log levels and every nested entry. Existing redactor truncation ellipses remain accepted at their documented caps. Logs/exceptions/usage are limited to 50/20/50 respectively.
- Event time may be at most **7 days old** or **5 minutes ahead** of ingestion time, inclusive; older/further-future timestamps drop. This bounds late delivery, not authoritative event-clock correctness.
- Usage provider/model/purpose are bounded structured names; input/output/cached counts are safe integers from zero through 50 million, cached cannot exceed input. Cost must be null or finite nonnegative dollars at most 10,000. Missing/null required token counts are rejected, **never fabricated as zero**. Nullable cache/cost and actual zero remain distinct.
- A canonical validated event may encode to at most **64 KiB of UTF-8 JSON bytes**. The selected valid batch's JSON array may encode to at most **1 MiB**, including brackets/commas. Exceeding the batch limit rejects the entire selected batch before SQL, rather than accepting a size-dependent prefix. Unknown/malformed inputs are never serialized as arbitrary raw payloads.
- These are **post-RPC-materialization application bounds**, not a service-binding transport-frame/memory limit. Large invalid individual strings are length-checked before serialization. This increment does not change tail redaction, source approval, tenant/project registration or bindings.

## Acceptance evidence

Typecheck and the default full suite pass **1481 tests / 158 files**. Four new tests exercise malformed scalars/nested entries (including a malformed final event), safe copying, missing versus zero token counts, cached-token conservation, exact timestamp boundaries, existing producer caps, exact per-event and batch UTF-8/escaped-JSON byte boundaries, one-byte overflow, multibyte overflow, no SQL on entirely invalid/oversized selections, valid siblings with exact original counts and more than 500 inputs through real local D1. The initial batch-boundary fixture accidentally exceeded the per-event cap in its final element; corrected the fixture's size calculation, without changing limits or assertions. Expected poisoned-Inbox exceptions in the full suite are deliberate unrelated boundary fixtures.

## Still required — not solved by validation

#107 remains under way: stable producer event IDs/source uniqueness, retry-idempotent transactional chunks and reliable reconciliation of partial database failures are **not implemented** here. Existing 100-statement batches can partially persist before a later batch fails; replaying input can double counts/usage. Do not blindly retry ambiguous telemetry sends or claim counters are idempotent. Source-schema changes and any real migrations require separate authorization; product code/tests for a follow-up are permitted. Existing fingerprint collision behavior, D1 bind limits for very diverse batches and notice delivery atomicity also remain unchanged. Validation/counting evidence is local, not an artificial production telemetry injection or live tail retry proof.

#132 remains independently blocked on native private-no-store BFCache restoration and genuine freeze/resume in an authorized headed fixture. Its previous presence increments are already released; no caching/privacy weakening or repetitive unavailable lifecycle probe accompanies this work.
