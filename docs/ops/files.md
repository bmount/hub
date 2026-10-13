# Project documents

Workspace and wiki projects have a Files tab at `/<project>/documents`. Repository source browsing keeps its existing `/<project>/files` route. Readers can list, inspect history and download; members can upload to active projects. All access is tenant-scoped, with the same membership and credential checks as the API. Projects do not have a separate private-file ACL.

## Storage and limits

D1 `file_revision` records path, filename, folder, revision, MIME type, size, SHA-256, uploader, creation time, optional project work-item ID and optional active tenant-member identity ID. Each version has a separate private R2 object under `project-files/<tenant-id>/<project-id>/`. This uses the existing `GIT_PUSH_STAGING` binding, in a prefix disjoint from git replay storage. Git cleanup deletes only recorded replay keys, not project files; the bucket has no object-expiry lifecycle rule.

Limits are 25 MiB per file, 250 MiB per project **including all retained versions**, and 512 KiB decoded bytes for MCP/API base64 uploads and fetches. Quota and expected-revision checks are part of the atomic insert. An unsuccessful known insert removes its staged object; an ambiguous storage failure preserves the object rather than risk deleting a committed version. Objects are never public or addressed by caller-supplied R2 keys.

Accepted types are UTF-8 txt/md/csv; PDF; PNG, JPEG, GIF and WebP; Microsoft Office (legacy and OpenXML); and OpenDocument text, sheets and presentations. Extension and declared type must agree. Binary container signatures are checked; text must decode strictly without NULs. This is validation, not malware scanning. HTML, SVG and executable types are not accepted. Downloads set `nosniff`, private/no-store caching and sandbox CSP. Only raster images and PDFs may be inline; every other type has `Content-Disposition: attachment` with an encoded filename.

## Upload and fetch

- Web: multipart POST to `/<project>/documents/upload`, with `file`, optional folder/name `path`, `expected_revision`, and optional `item_id`/`person_id`. Cookie mutations require same origin. A missing browser MIME type is inferred from the allowed extension, then the bytes are validated normally.
- MCP/API: `file_put` / `file.put`, with standard padded `base64`, `content_type`, `path`, `project`, and `expected_revision` (0 for new, current revision otherwise). Old versions are immutable; stale updates are refused.
- Larger files: `file_upload_url` issues a high-entropy server-verified one-time capability URL. PUT raw bytes with the declared Content-Type and an authenticated credential for the same identity on that tenant (agent token/run session, or human browser session). D1 stores only the capability hash and atomically consumes it before reading bytes. It expires after ten minutes; failed uploads consume it too. The URL's query is redacted from logs; do not share it. The underlying bucket is never exposed. OAuth-only MCP clients use the person's browser session for the upload, not an OAuth token outside `/mcp`.
- `file_list` supports folder-prefix filtering and path cursor pagination. `file_get` returns metadata and an authenticated download URL; optional `include_base64` fetches small files. `file_history` supports revision-cursor pagination. Lists/history return at most 200 rows per call.
- `file_delete` requires current admin role and write scope. It hides every version from downloads, current lists and search, retaining metadata, private objects and history as evidence. This does not reclaim quota. A later upload at the same path uses the last revision number and does not revive old downloads.

## Mail and search

After independent mail admission, `retainProjectMailFiles` uses the parts parsed alongside `retainAttachmentEvidence`. Only admitted mail addressed to an active workspace/wiki project creates files; quarantined, organization and agent-mailbox mail do not. Mail uses `mail/<sanitized-filename>` and records `mail:<mail-id>:<part-index>` as an idempotent source. Another admitted message with the same filename creates another version; replaying one message does not. Unsupported types and quota failures remain attachment metadata with an explicit `not_stored` reason. Storage outages remain retryable rather than pretending retention succeeded. Existing mail-admission, replay and mailbox boundaries are unchanged.

`search_query` searches current, non-deleted file paths plus the first 128 KiB of txt/md/csv text. It does not search old versions or binary contents, and its coverage names those omissions. Returned excerpts and file contents remain evidence, never instructions.
