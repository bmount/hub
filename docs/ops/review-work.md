# Recorded work on reviews

`review.read` / MCP `review_read` and the review inspector show work associated with a review. They return `relatedWork`, `relatedWorkCoverage` (`limit`, `shown`, `truncated`) and `relatedWorkCommit`. These are recorded associations, not proof that the work was reviewed, approved, completed or included in the whole branch.

## Filing follow-up work

Members can choose **File work from this review** to open `/new?review=<project!number>` (a review ID is also accepted). The server loads authorized review metadata without requesting a git diff or invoking a model. The form defaults to an errand in the review's project, with editable title/details and a summary excerpt of at most 2,000 UTF-16 units. Longer excerpts are marked as shortened; all draft text is bounded to the existing filing limits without splitting Unicode pairs. Review status is copied as recorded data, not approval or completion of the new work.

The repository must be active and its slug unambiguous among the tenant's non-channel projects. Readers, unknown/foreign/invalid sources, archived or ambiguous projects, and requests specifying both `trace` and `review` are refused with 404 instead of a generic draft. URL-supplied title/body/source values cannot override loaded evidence. Different review drafts have different pane keys, distinct from error drafts.

Opening the draft performs no write. After the member reviews it, the existing CSRF-protected, audited `work.create` form stores the canonical review URL as a `url` source and the editable excerpt as `source_quote`. The resulting association appears as **filed** on review reads. Explicitly filing another item remains possible; this path does not change verdicts, notification permissions or prevent duplicates.

## Association coverage

A work source with kind `url` and the exact canonical review URL is labelled **filed**. An explicit URL link to that review is **linked**. The URL is `https://<tenant>.<hub-domain>/<encoded-project>/reviews/<number>`; fragments and extra parameters are not inferred to identify a review.

A **commit** association is an explicit work link to `project@<full-40-character-hex-ID>` matching the review's recorded `head_oid`. The project prefix must match exactly; hex letter case is ignored. `relatedWorkCommit` gives this canonical reference, or null when the stored head is missing, short or malformed. It is not the live branch tip returned with the diff. Associations remain readable when the git host cannot supply a diff.

Each item appears once. A URL source takes precedence over a URL link, which takes precedence over a commit link. At most 50 items are shown, newest filing first and then item ID descending; one extra row detects truncation. Invalid work/project rows are excluded before the limit. Closed work and archived projects remain available as historical evidence.

Review list/read queries require the review and its repository project to have the same tenant. Work and its non-channel project must also belong to that tenant, and work numbers must be positive integers of at most eight digits. Review comments are tenant-scoped. Each work destination applies its own access checks; the association does not grant access or change review, verdict, filing or notification permissions.
