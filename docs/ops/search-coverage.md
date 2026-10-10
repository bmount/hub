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

Repository file contents, binary/unextracted attachments and raw telemetry logs are not indexed. Attachment matches cover stored extracts, which may themselves be truncated. Total matches and ingestion freshness are not claimed. A failed source fails the request rather than pretending to have no matches.

## Verifying and shipping a change

Use the existing search and mailbox tests for matching, privacy, archived channels, literal wildcards and escaped output. The browser test in `test/browser/assistant.test.ts` types a phrase found only in details/comments of two different projects, presses Enter immediately, opens both results, and checks keyboard jumps on desktop and mobile layouts. It uses a real browser and bundled Worker with disposable synthetic data, not production credentials.

For a manual change, reproduce the interaction, run focused tests while editing, then the full `npm test` suite and `npm run typecheck`. Commit one logical change, merge normally, and use the managed release helper. Verify the live version and search client artifact before closing the item. Keep release/test evidence in the ticket, not this document.
