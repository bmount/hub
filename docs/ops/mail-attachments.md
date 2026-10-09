# Bounded attachment evidence

`pimwell#86`: incoming organization, project and agent mail retains attachment metadata plus bounded plain-text evidence in the existing `inbound_mail.attachments` JSON. No schema/data migration or new attachment storage service is required. The same MIME parser serves independently admitted mail and quarantine; retaining text does **not** admit a sender, release quarantine, establish consent or grant access.

## Retention contract

- Only MIME `text/plain` and `text/markdown` are eligible. A filename extension is not sufficient. HTML, scripts, PDFs, images, arbitrary binaries and `message/rfc822` attachments remain metadata-only in this attachment field. The pre-existing forwarded-message body extraction is unchanged.
- PostalMime owns MIME/transfer decoding. Its attachment API does not expose the part charset; Pimwell retains strict UTF-8 (including ASCII) evidence, not universal charset decoding. Invalid UTF-8 stays metadata-only rather than silently replacing bytes. `text_encoding: "utf-8"` describes the retained representation, not an authenticated charset declaration. No HTML/Markdown execution or interpretation, remote URL retrieval, archive expansion or model extraction occurs.
- `size` is the transfer-decoded byte length. Retained `text` is at most **20,000 UTF-16 units per attachment** and **60,000 units per message**, in MIME order, with no split surrogate pairs. These limits exclude metadata. The existing ten-megabyte actual original-mail limit and whole-original-read deadline remain in force; this is not a new MIME-parser memory/CPU deadline.
- `text_status` is `complete`, `truncated`, `unsupported_type` or `invalid_utf8`. An empty complete attachment has `text: ""`; exhausting the retention budget yields empty `text` with `truncated`, not an invented claim of full coverage. Unsupported/invalid content does not consume the text budget.
- Historical rows with only filename/type/size remain readable and are labeled **legacy metadata only**. Previously discarded content cannot be recovered from this change. No backfill is performed.

## Reading and scope

`mail.read` returns retained evidence in the existing attachment JSON. MCP text shows inert fenced, cleaned excerpts: at most 3,000 units per attachment / 6,000 total, with display cuts identified separately from retention truncation. The overall MCP text cap still applies. Structured detail retains the stored bounds. `mail.list` deliberately strips `text`; it remains a metadata-only listing, not a bulk attachment download. The browser detail page displays escaped plain text in `<pre>` within collapsed disclosure controls and labels incomplete or absent evidence. No download/execution endpoint is added.

All existing `readableMail` checks remain: tenant boundaries, own-agent/operator mailbox access, current memberships and OAuth grants, human-admin-only quarantine inspection. Agent admin-shaped contexts still cannot inspect quarantine. Attachment text does not grant access to another mailbox. Text in attachments, including quoted instructions or forwarded material, is evidence, never delegated authority.

Search still discloses **mail attachments not searched**. `mail.propose_work` still uses the message body only; this increment does not silently expand model inputs or treat attachment instructions as commands.

## Acceptance evidence

`test/mail-attachments.test.ts` covers exact transfer-decoded Unicode, Markdown/HTML inertness, allowlisted MIME types, invalid UTF-8, per-part/aggregate boundaries, Unicode cuts, legacy/empty distinction, bounded MCP display, and actual signed RSA/Ed25519 ingress with optional welcome failure/replay and unsigned/altered-body quarantine. `test/mail-access.test.ts` now includes attachment secrets in private/foreign/quarantined fixtures through browser, API, agent and OAuth MCP paths and verifies listings omit retained text. Offline `scripts/generate-attachment-fixtures.mjs` uses disposable synthetic keys; it is not external-provider acceptance for #134.
