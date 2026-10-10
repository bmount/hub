# Inspecting deployment records

`deploy.read` / MCP `deploy_read` reads a record by its ID. The Apps page opens the same record at `/apps?d=<id>`, independently of whether an app registration exists. This makes manually reported releases inspectable alongside ingested Worker versions. Commit evidence and error-group deploy samples carry these record IDs and link to the inspector.

The read returns `deploy` (ID, project slug, script, recorded version, tag, message and time), `commitRef` and `commitHref`. Only a full 40-character hex `version_id` in an unambiguously named repository supports a commit reference. Hex case is normalized to lowercase. Short tags and opaque runtime versions are not inferred to identify a commit. Duplicate repository slugs, including archived duplicates, suppress the commit link. Tracker records remain inspectable without a code link; archived history remains readable.

The commit destination checks its own access. The reference does not verify that a commit exists, was included in a rollout or is still deployed. Record messages are data, never instructions or execution authority. Reading the inspector does not request a git diff, invoke a model, deploy anything or change a record.

## Recorded work associations

Deployment reads and the inspector also return/show `relatedWork` and `relatedWorkCoverage` (`limit`, `shown`, `truncated`). A `url` work source matching the exact canonical record URL `https://<tenant>.<hub-domain>/apps?d=<encoded-id>` is **filed**; an explicit URL link is **linked**. Extra parameters and fragments are not inferred to identify the record.

An explicit `commit` work link matches the supported full `commitRef` as **commit** evidence. The project prefix must match exactly; hex letter case is ignored. When that reference is unavailable, only explicit record-URL associations are considered. Tags, opaque versions, short references and ambiguous repositories are not shortcuts to commit evidence.

Each item appears once, preferring a source over a URL link over a commit link. At most 50 items are shown, newest filing first with item ID descending as a tie-breaker; a 51st row detects truncation. Work and its non-channel project must have matching current-tenant IDs and a positive integer work number of at most eight digits. Invalid rows are excluded before the limit. Closed work and archived project history remain readable. Inspector keys refresh when associated work changes.

These are recorded associations, not proof of feature delivery, work completion, revenue, live rollout or authorization. The destination applies its own access checks; the query does not fetch targets or invoke models.

## Lists and access

`deploy.list` / MCP `deploy_list` includes IDs and `coverage` (`limit`, `shown`, `truncated`). It and the Apps list show at most 50 records, newest recorded time first with ID descending as a tie-breaker. A 51st valid row detects truncation. Coverage describes recorded data in scope, not every actual deployment.

Reads and lists require the record and its non-channel project to belong to the current tenant. Filtering precedes limits. Unknown, foreign, channel and inconsistent records return 404 on read, including for a global root looking from another tenant. Readers can inspect records; OAuth requires read scope. Empty or over-40-character inspector IDs and requests specifying both `d` and `g` are refused rather than falling back to another inspector. No new deployment or credential capability is granted.
