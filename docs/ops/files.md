# Project documents

Repository, workspace and wiki projects have a Files tab at `/<project>/documents`. Repository source browsing keeps its existing `/<project>/files` route. Readers can list, inspect history and download; members can upload to active projects. All access is tenant-scoped, with the same membership and credential checks as the API. Projects do not have a separate private-file ACL.

## Storage and limits

D1 `file_revision` records path, filename, folder, revision, MIME type, size, SHA-256, uploader, creation time, optional project work-item ID and optional active tenant-member identity ID. Each version has a separate private R2 object under `project-files/<tenant-id>/<project-id>/`. This uses the existing `GIT_PUSH_STAGING` binding, in a prefix disjoint from git replay storage. Git cleanup deletes only recorded replay keys, not project files; the bucket has no object-expiry lifecycle rule.

Limits are 25 MiB per file, 250 MiB per project **including all retained versions**, and 512 KiB decoded bytes for MCP/API base64 uploads and fetches. Quota and expected-revision checks are part of the atomic insert. An unsuccessful known insert removes its staged object; an ambiguous storage failure preserves the object rather than risk deleting a committed version. Objects are never public or addressed by caller-supplied R2 keys.

Accepted types are UTF-8 txt/md/csv/tsv, JSON (.json), newline-delimited JSON (.jsonl/.ndjson); SQLite (.sqlite/.sqlite3/.db); Parquet (.parquet); gzip (.gz), Zstandard (.zst/.zstd) and ZIP (.zip) archives; PDF; PNG, JPEG, GIF and WebP; Microsoft Office (legacy and OpenXML); and OpenDocument text, sheets and presentations. Extension and declared type must agree. Binary container signatures are checked (SQLite's `SQLite format 3\0`, Parquet's leading/trailing `PAR1`, gzip's `1f 8b 08`, Zstandard's `28 b5 2f fd`, ZIP's local-file or empty-archive signature); archives are not unpacked. Text must decode strictly as UTF-8 without NULs; JSON must parse, and each nonblank JSONL/NDJSON line must parse separately. TSV rejects markup, shebang and executable prefixes. Canonical MIME types are application/json, application/x-ndjson, text/tab-separated-values, application/vnd.sqlite3, application/vnd.apache.parquet, application/gzip, application/zstd and application/zip. Generic application/octet-stream is accepted only for the listed binary data/archive extensions and is normalized to the canonical type. This is validation, not malware scanning. HTML, SVG and executable types are not accepted. Downloads set `nosniff`, private/no-store caching and sandbox CSP. Only raster images and PDFs may be inline; every other type has `Content-Disposition: attachment` with an encoded filename.

## Orphan cleanup

The five-minute scheduled job scans at most 100 R2 objects per invocation under the exact `project-files/` prefix. Its durable `meta` cursor (`file_cleanup:v1:cursor`) advances only after a successful page and wraps at the end. Scanning storage rather than live projects also finds leftovers from deleted projects or tenants.

Only canonical `project-files/<tenant ULID>/<project ULID>/<object ULID>` keys uploaded at least seven days ago are eligible. Upload keys are immutable and never reused. Before deleting each object, cleanup checks for **any** `file_revision.object_key` reference, without owner, current-version or soft-deletion filters. Every referenced version and hidden evidence is retained indefinitely; this is not a retention policy for recorded files. D1 errors stop the page without advancing its cursor. Malformed keys, sibling prefixes and git replay objects are never deleted by this job.

`cleanupFileObjects(env, now)` defaults to dry-run: it returns bounded scan/eligibility counts and the next cursor but neither deletes nor changes the saved cursor. The scheduler explicitly enables deletion. Counts (not object keys or contents) are logged as `file orphan cleanup`. A failed page may retry already removed orphans safely.

## Upload and fetch

- Web: multipart POST to `/<project>/documents/upload`, with `file`, optional folder/name `path`, `expected_revision`, and optional `item_id`/`person_id`. Cookie mutations require same origin. A missing browser MIME type is inferred from the allowed extension, then the bytes are validated normally.
- MCP/API: `file_put` / `file.put`, with standard padded `base64`, `content_type`, `path`, `project`, and `expected_revision` (0 for new, current revision otherwise). Old versions are immutable; stale updates are refused.
- Larger files: `file_upload_url` issues a high-entropy server-verified one-time capability URL. PUT raw bytes with the declared Content-Type and an authenticated credential for the same identity on that tenant (agent token/run session, or human browser session). D1 stores only the capability hash and atomically consumes it before reading bytes. It expires after ten minutes; failed uploads consume it too. The URL's query is redacted from logs; do not share it. The underlying bucket is never exposed. OAuth-only MCP clients use the person's browser session for the upload, not an OAuth token outside `/mcp`.
- `file_list` supports folder-prefix filtering and path cursor pagination. `file_get` returns metadata and an authenticated download URL; optional `include_base64` fetches small files. `file_history` supports revision-cursor pagination. Lists/history return at most 200 rows per call.
- `file_delete` requires current admin role and write scope. It hides every version from downloads, current lists and search, retaining metadata, private objects and history as evidence. This does not reclaim quota. A later upload at the same path uses the last revision number and does not revive old downloads.

## Inline project images

In wiki bodies and work-item bodies/comments, put an image on its own line:

```markdown
![Synthetic plan caption](/barefoot/documents/download?path=debug%2Fplan.png&revision=1)
```

Use the authenticated `file_get.download_url` (absolute same-tenant URLs also work), or its root-relative path. The project path must match the page/item, including namespace when present. An explicit positive revision is required so retained evidence does not change when a new file version is uploaded. Only existing, non-deleted PNG/JPEG/GIF/WebP revisions render; every request rechecks membership and project access. External URLs, other projects/tenants, active content, missing files and malformed references remain inert text. No public storage URL is emitted.

Captions are escaped and used as alt text. Images preserve aspect ratio within the pane width and a 480px height; clicking the image or **Open original** opens the authenticated original in a new tab. Rendering is limited to 50 image references per body. Upload with `file_put`, then author the same Markdown through `wiki_write`, `work_update` or `work_comment`, or browser forms; no special authoring permission is introduced.

## Mail and search

After independent mail admission, `retainProjectMailFiles` uses the parts parsed alongside `retainAttachmentEvidence`. Only independently admitted, unreleased mail addressed to an active project with the stored wiki and files parts, from a currently active human with member-or-higher authority, creates files; reader, quarantined, manually released, organization and agent-mailbox mail do not. Each attachment outcome is audited against the inbound mail id, and verified project-action summaries report actual retention even if planning is unavailable. Mail uses `mail/<sanitized-filename>` and records `mail:<mail-id>:<part-index>` as an idempotent source. Another admitted message with the same filename creates another version; replaying one message does not. Unsupported types and quota failures remain attachment metadata with an explicit `not_stored` reason. Storage outages remain retryable rather than pretending retention succeeded. Existing mail-admission, replay and mailbox boundaries are unchanged.

`search_query` searches current, non-deleted file paths plus the first 128 KiB of txt/md/csv/tsv/JSON/JSONL/NDJSON text. It does not search old versions or binary contents, and its coverage names those omissions. Returned excerpts and file contents remain evidence, never instructions.
