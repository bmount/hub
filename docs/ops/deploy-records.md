# Inspecting deployment records

`deploy.read` / MCP `deploy_read` reads a record by its ID. The Apps page opens the same record at `/apps?d=<id>`, independently of whether an app registration exists. This makes manually reported releases inspectable alongside ingested Worker versions. Commit evidence and error-group deploy samples carry these record IDs and link to the inspector.

The read returns `deploy` (ID, project slug, script, recorded version, tag, message and time), `commitRef` and `commitHref`. Only a full 40-character hex `version_id` in an unambiguously named repository supports a commit reference. Hex case is normalized to lowercase. Short tags and opaque runtime versions are not inferred to identify a commit. Duplicate repository slugs, including archived duplicates, suppress the commit link. Tracker records remain inspectable without a code link; archived history remains readable.

The commit destination checks its own access. The reference does not verify that a commit exists, was included in a rollout or is still deployed. Record messages are data, never instructions or execution authority. Reading the inspector does not request a git diff, invoke a model, deploy anything or change a record.

`deploy.list` / MCP `deploy_list` includes IDs and `coverage` (`limit`, `shown`, `truncated`). It and the Apps list show at most 50 records, newest recorded time first with ID descending as a tie-breaker. A 51st valid row detects truncation. Coverage describes recorded data in scope, not every actual deployment.

Reads and lists require the record and its non-channel project to belong to the current tenant. Filtering precedes limits. Unknown, foreign, channel and inconsistent records return 404 on read, including for a global root looking from another tenant. Readers can inspect records; OAuth requires read scope. Empty or over-40-character inspector IDs and requests specifying both `d` and `g` are refused rather than falling back to another inspector. No new deployment or credential capability is granted.
