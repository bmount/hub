# Wiki pages

Wiki and workspace projects support Markdown pages at `/<project>/wiki`. Members create pages with a canonical lowercase hyphenated slug, title, body and revision note. Readers can view pages, history and diffs. The renderer escapes text before adding a small Markdown subset and same-project `[[page-slug]]` links; raw HTML is never rendered. Links to missing pages remain links; the page list's new-page form can create the target. Backlinks describe current non-deleted pages, including when viewing old revisions.

## Verbs and history

`wiki_list`, `wiki_read`, `wiki_history` require read scope; `wiki_write` requires write scope and member role. `wiki_delete` requires write scope and current admin role (the narrowly scoped admin-content exception to MCP's member ceiling). The same verbs are served under `/api/wiki.*`, and the web forms use them with the normal session and same-origin checks.

`wiki.write` requires `expected_revision`: zero creates a page; otherwise it must equal the page's current head. A single conditional SQL insert compares and appends atomically, refusing stale or simultaneous edits with 409. Every revision retains its title, body, links, author identity, timestamp and note. Reverting reads a historical revision and writes its title/body with the current expected revision. Web history links open a revert form; saving creates a new revision, never rewrites history.

Deletion appends a tombstone, hiding the page from the list, current read and search but preserving history. Historical reads remain available; restore by writing against the tombstone's revision. Slugs cannot restart at revision zero after deletion. Archived projects are read-only.

## Storage and limits

The additive `wiki_revision` D1 table stores immutable revisions. Bodies are limited to 128 KiB UTF-8, safely below D1's row limit including link metadata; oversized writes are rejected, not truncated. No R2 binding or external index is needed. Titles are at most 200 characters, slugs 100 and notes 500. Slug and project lookups are tenant-bound; these routes use top-level project slugs, not namespace paths.

Lists and history return up to 200 entries with `next_cursor`: use `after` for a page list and `before` for history. Backlinks return up to 200 current pages. Diffs use the existing bounded line-diff implementation, which reports truncation rather than claiming completeness. `search_query` and web search match only current non-deleted wiki slugs, titles and bodies, up to 20 hits; old revisions are not searched.
