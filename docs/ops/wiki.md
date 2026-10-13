# Wiki pages

Workspace knowledge bases use this same page engine, with research as a typed revision (the nullable `research` JSON column in `wiki_revision`), not a second document store.

## Workspace research

`research_save` (member/write) accepts project, slug, expected_revision, topic, summary, draft/final status, sources and a revision note. Each source has exactly one HTTP(S) URL or current workspace file path, a title, ISO retrieved_at timestamp and quote. URLs are recorded, never fetched. Author is the authenticated caller, person or agent; it cannot be supplied or impersonated. Structured content is limited to 64 KiB, with at most 50 sources or references per list. A searchable text projection occupies the normal wiki body.

Optional `people` are active tenant member identity IDs; `items` are validated tenant-local project#number references. `orgs` are named external-organization references, pending the workspace organization graph; they do not grant access to any other tenant. `research_list` (reader/read) returns structured fields and author, filtering by topic substring, exact person/org reference and status, with an alphabetical after cursor (200/page).

The workspace home shows KB pages and research together. Research opens at the regular wiki page URL with source links, quotes, linked items and revision history/diffs. Revise or revert structured pages with `research.save`; ordinary wiki writes cannot replace research metadata, and research cannot overwrite a KB page. Admin wiki deletion retains the structured history. Search includes current research topic, summary, sources, references and author display name under wiki results, with the same coverage limits.

Wiki and workspace projects support Markdown pages at `/<project>/wiki`. Members create pages with a canonical lowercase hyphenated slug, title, body and revision note. Readers can view pages, history and diffs. The renderer escapes text before adding a small Markdown subset and same-project `[[page-slug]]` links; raw HTML is never rendered. Links to missing pages remain links; the page list's new-page form can create the target. Backlinks describe current non-deleted pages, including when viewing old revisions.

## Verbs and history

`wiki_list`, `wiki_read`, `wiki_history` require read scope; `wiki_write` requires write scope and member role. `wiki_delete` requires write scope and current admin role (the narrowly scoped admin-content exception to MCP's member ceiling). The same verbs are served under `/api/wiki.*`, and the web forms use them with the normal session and same-origin checks.

`wiki.write` requires `expected_revision`: zero creates a page; otherwise it must equal the page's current head. A single conditional SQL insert compares and appends atomically, refusing stale or simultaneous edits with 409. Every revision retains its title, body, links, author identity, timestamp and note. Reverting reads a historical revision and writes its title/body with the current expected revision. Web history links open a revert form; saving creates a new revision, never rewrites history.

Deletion appends a tombstone, hiding the page from the list, current read and search but preserving history. Historical reads remain available; restore by writing against the tombstone's revision. Slugs cannot restart at revision zero after deletion. Archived projects are read-only.

## Storage and limits

The additive `wiki_revision` D1 table stores immutable revisions. Bodies are limited to 128 KiB UTF-8, safely below D1's row limit including link metadata; oversized writes are rejected, not truncated. No R2 binding or external index is needed. Titles are at most 200 characters, slugs 100 and notes 500. Slug and project lookups are tenant-bound. Project arguments accept a top-level slug or `namespace/project`; bare slugs never select namespaced projects on the organization endpoint. Overview and feature URLs use the same path (`/namespace/project/wiki/page`, `/namespace/project/documents`, `/namespace/project/contacts`), including forms, history, backlinks and search results. A project MCP endpoint pins its project ID, supplies the canonical path for knowledge tools, and refuses other project paths; its own bare slug remains accepted for compatibility.

Lists and history return up to 200 entries with `next_cursor`: use `after` for a page list and `before` for history. Backlinks return up to 200 current pages. Diffs use the existing bounded line-diff implementation, which reports truncation rather than claiming completeness. `search_query` and web search match only current non-deleted wiki slugs, titles and bodies, up to 20 hits; old revisions are not searched.
