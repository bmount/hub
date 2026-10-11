# Search

## Using it

The upper box searches across all projects in the current organization. Type words and press Enter for grouped results with matching excerpts. Suggestions include content matches and quick jumps to projects, people, sections and work references. Click a suggestion or select it with the arrow keys and Enter to jump directly. Ctrl+K or Command+K focuses the box. Without JavaScript, the form still opens `/search`.

Enter searches even if suggestions have not loaded. Typing three words does not turn a search into an assistant action. Recent jumps are stored separately for each signed-in identity in that browser.

## Content and permissions

Search includes:

- Work titles, details, source quotes and comments, across projects.
- Readable inbound mail and stored extracted attachment text.
- Readable outgoing mail, including recorded unsuccessful attempts.
- Current, non-retracted chat messages in active and archived channels.
- Review titles, summaries and comments.
- Situation questions, reports and outcomes.
- The caller's own assistant conversation titles and messages.
- People, project names and app error titles/messages.

Tenant boundaries apply before matching and limiting results. Mail uses the shared `readableMail` and `readableOutgoingMail` predicates. Agents search only channels they can read. Assistant conversations require the caller's exact identity and tenant; being an administrator does not grant access to another person's private assistant conversations. Search does not expand any permissions.

Message hits open their exact permalink. Outgoing hits open a permission-checked read-only mail page. HTML is escaped; suggestion labels and excerpts are assigned as text, never executed.

## Implementation and limits

`searchAll` in `src/verbs/search.ts` supplies `/search`, the upper-box JSON suggestions, and MCP `search_query`. It uses parameterized substring matching over the existing D1 tables and the channel Durable Objects. There is no new index, migration or external search service.

All effective words must match. Queries use the first six whitespace-separated words of at least two characters. `%`, `_` and backslashes are literal, not search wildcards. Excerpts show text around a match.

Results are bounded: 20 work items, 15 each for mail, chat, reviews, situations, assistant conversations and outgoing mail, and 10 each for people, projects and app errors. Chat searches up to 40 readable channels and returns up to 10 matches from each. Search scope and limits are available beneath the search form; hitting a cap is not an exact total.

Binary/unextracted attachments and raw telemetry logs are not indexed. Repository files are searched separately, below. Attachment matches cover stored extracts, which may themselves be truncated. Total matches and ingestion freshness are not claimed. A failed source fails the request rather than pretending to have no matches.

## Code search

MCP `repo_search` (`repo.search` in `src/verbs/code.ts`) searches one repository's files at a branch, tag or commit, defaulting to the main branch. `q` is literal and case-insensitive unless `case_sensitive` or `regex` is set; `path` limits it to a path prefix. It returns matching lines with file and line number, up to `limit` (default 50, at most 200), and says when more exist.

Artifacts has no grep or archive endpoint, and reading files one REST call at a time would cost hundreds of API requests per search. Instead the Artifacts adapter (`snapshot` in `src/code/artifactRead.ts`) makes one Git protocol-v2 fetch with `deepen 1`, reads the pack in the Worker (`src/code/gitPack.ts`) and caches the commit's files in the Workers cache keyed by project and commit. Commits never change, so the first search of a commit pays for the fetch and later ones read the cache. Access is checked through the caller's Git session before the cache is read.

Binary files and files over 400 KB are skipped and counted. Regex matching looks at the first 2,000 characters of each line. Submodules are not followed.

## Verifying and shipping a change

Use the existing search and mailbox tests for matching, privacy, archived channels, literal wildcards and escaped output. The browser test in `test/browser/assistant.test.ts` types a phrase found only in details/comments of two different projects, presses Enter immediately, opens both results, and checks keyboard jumps on desktop and mobile layouts. It uses a real browser and bundled Worker with disposable synthetic data, not production credentials.

For a manual change, reproduce the interaction, run focused tests while editing, then the full `npm test` suite and `npm run typecheck`. Commit one logical change, merge normally, and use the managed release helper. Verify the live version and search client artifact before closing the item. Keep release/test evidence in the ticket, not this document.
