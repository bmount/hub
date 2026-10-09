# Creation-only deploy and work-link audit

`work.link` and `deploy.record` are create-if-absent commands. A successful
response now includes `created`: true only for the request that inserted the
record. Repeated or concurrent commands return the persisted original record,
not a newly fabricated ID or the losing request's metadata.

- Work links retain their existing unique key `(item_id, target_kind,
  target_ref)`. HTTPS targets are validated/canonicalized before lookup. The
  response retains `link` and `ref`; `link` preserves the original ID, note,
  creator and creation time. Only actual creation touches `work_item.updated_at`.
- Deploys retain their existing unique key `(script_name, version_id)`, where
  manual script names remain `<project>:<environment>`. The response retains
  `project`, `commit`, `environment`, and adds the persisted `deploy` row.
  Duplicate requests never replace the original message, tag or seen time.
- Current authorization still runs before reconciliation. A previous successful
  request is not a grant to a reader, another tenant or an archived project.

## Atomicity

Creation, conditional audit and (for links) item touch are in one D1 batch
transaction. `ON CONFLICT` targets the expected logical duplicate key rather
than ignoring unrelated database errors. `RETURNING` determines creation.
Audit/item touch are conditioned on the attempt's freshly minted internal row
ID; a duplicate cannot authorize another event using the existing winner's ID.
The final tenant/item-scoped SELECT in the same batch returns the winner.

Audit failure rolls back the insertion and item touch. A caller that loses its
response can repeat the same key and reconcile the durable record without
adding another `work.link` or `deploy.record` event. This is key-based
create-if-absent behavior, not an arbitrary command idempotency service. Different
keys still represent different records; these commands do not send email or
announce chat messages.

## Existing deploy-key limitation

The schema's deploy key is global, not tenant-scoped. Two organizations with the
same project slug, environment and commit can collide. This increment does not
change schema or rename legacy script keys: it returns a generic conflict for
that case, never the other tenant's row or metadata, and emits no false event.
Resolving this compatibility limitation needs a separately tested schema/key
migration. It is not safe to use an unscoped duplicate SELECT.

## Regression evidence

`test/creation-audit.test.ts` covers repeated calls by different members,
canonical work URLs, original authorship/session provenance, unchanged duplicate
item timestamps, concurrent winner selection, independent keys, current access
checks, legacy cross-tenant deploy collisions and trigger-injected audit failure
with transactional rollback/retry. Existing URL security and telemetry tests
continue to cover unsafe links and ordinary deploy reads.
