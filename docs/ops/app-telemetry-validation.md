# App telemetry validation

`Ingest.events` validates a bounded copy before any SQL. A service binding authenticates the caller, not the payload shape. Malformed nested logs, exceptions or usage drop the whole event; valid siblings may proceed. Unknown fields are rejected, not retained or logged.

## Input bounds

Only the first 500 original inputs are considered. On successful ingestion, `accepted + dropped` equals the original array length, including malformed, unapproved and excess inputs. Non-array input returns zero/zero.

Events require bounded nullable scalar fields, safe integer timestamps and valid HTTP statuses. Logs, exceptions and usage entries are limited to 50, 20 and 50 respectively. Every nested entry is validated. Existing source truncation ellipses are accepted.

Event time may be at most seven days old or five minutes ahead of ingestion time, inclusive. This limits late delivery; it does not establish authoritative clock correctness.

Usage provider, model and purpose are bounded structured names. Input, output and cached counts are safe integers from zero through 50 million; cached cannot exceed input. Cost is null or finite nonnegative dollars up to 10,000. Missing required token counts are rejected, never invented as zero. Nullable cache/cost and actual zero remain distinct.

A validated event may encode to at most 64 KiB of UTF-8 JSON. The selected valid batch may encode to at most 1 MiB, including array brackets and commas. Batch overflow rejects the entire selection before SQL rather than accepting a size-dependent prefix. Malformed raw payloads are not serialized for measurement or logging.

These are post-materialization application bounds, not RPC transport-frame limits. Individual strings are length-checked before serialization.

## Database lookups and writes

Source, version and error-group lookups use serial queries with at most 100 bound values each, matching D1's parameter limit. Every lookup finishes before writes begin; a failed later lookup rejects the call without persisting a prefix. Empty version or fingerprint sets issue no lookup. Source, project and tenant must all be active for an event to count.

Writes still use batches of up to 100 statements. Stable producer event IDs, retry-idempotent chunks and reconciliation of partial write failures are not implemented. A later write batch can fail after earlier batches persist; replay can double counts and usage. Do not blindly retry ambiguous telemetry sends. Fingerprint collision behavior and notice delivery atomicity remain separate limitations.
