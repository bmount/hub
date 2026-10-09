# Search coverage and limits

`search.query` (MCP `search_query`) and `/search` search available evidence, not everything in the organization. The existing six hit arrays (`work`, `mail`, `messages`, `people`, `projects`, `errors`) remain. An additive `coverage` object accompanies successful results, including zero hits. Consumers must treat `coverage` as metadata, not another hit array.

## Currently searched

- Work title, body, source quote and comments: at most 20 hits, title matches first.
- Caller-readable admitted inbound mail subject, text and sender: at most 15 hits. The existing mailbox/operator/tenant predicate applies before the limit.
- Caller-readable **active** conversations: first 40 channels in channel-slug order, at most 10 matching messages per channel, then at most 15 messages globally by creation time. Channel totals in coverage count only channels the caller can read, never inaccessible channels. Humans and agents keep their existing distinct channel access rules.
- Active members' display names and email addresses: at most 10 hits.
- Non-channel project slugs and display names: at most 10 hits.
- Stored app-error group title, latest message and script name: at most 10 hits.

Matching is the existing case-insensitive all-term substring search. Only the first six whitespace-separated words of two or more characters are used; `coverage.terms_used` records those effective terms. `%` and `_` remain literal search characters, not wildcard authority.

Each `coverage.sources` entry gives `returned`, `limit`, `total_matches: null` and conservative `may_have_more`. Reaching a result cap means more matches **may** exist, not that they definitely do. Conversations also flag omitted readable channels or a reached per-channel hit cap, even if fewer than 15 messages were returned. Below-cap results describe only the searched fields/records, not universal absence.

## Not searched / unknown

Outbound mail, mail attachments, reviews, situations, repository code and archived conversations are explicitly listed as not searched. This is a product implementation limit, not a list of hidden resources, a permission grant, or proof any such record exists. No new indexing or permission bypass was added.

Total matching records and source freshness remain unknown. Stored receive/update timestamps are not continuous-ingestion or synchronization watermarks. These reads are not an atomic cross-D1/DO snapshot. Source/query failure still fails the request rather than returning a misleading successful empty source. No new search-wide deadline, pagination, full-scan redesign or freshness ledger is claimed; those remain separate work (#108/#118/#119).

MCP's inert-data note remains before results; its text and the escaped browser page show coverage for both hits and zero hits. Initial browser guidance also names the limited searched sources. Existing `work.search` and `message.search` hit-only contracts are unchanged by this increment.

Regression tests: `test/search-coverage.test.ts`, `test/search.test.ts`, `test/mail-access.test.ts`. Native Workers tests cover zero versus unknown, effective terms, exact/over/under caps, 41-readable-channel truncation, per-channel truncation below the global cap, agent-only visibility, other tenants and archives, API/MCP/browser parity, inert rendering and anonymous denials. Additional evidence-source indexing and performance work remain open; these tests are not a production-load benchmark.
