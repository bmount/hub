# Search coverage and limits

`search.query` (MCP `search_query`) and `/search` search available evidence, not everything in the organization. The existing six hit arrays (`work`, `mail`, `messages`, `people`, `projects`, `errors`) remain, with an additive `situations` hit array. An additive `coverage` object accompanies successful results, including zero hits. Consumers must treat `coverage` as metadata, not another hit array.

## Currently searched

- Work title, body, source quote and comments: at most 20 hits, title matches first.
- Caller-readable admitted inbound mail subject, text and sender: at most 15 hits. The existing mailbox/operator/tenant predicate applies before the limit.
- Caller-readable **active** conversations: first 40 channels in channel-slug order, at most 10 matching messages per channel, then at most 15 messages globally by creation time. Channel totals in coverage count only channels the caller can read, never inaccessible channels. Humans and agents keep their existing distinct channel access rules.
- Active members' display names and email addresses: at most 10 hits.
- Non-channel project slugs and display names: at most 10 hits.
- Stored app-error group title, latest message and script name: at most 10 hits.
- Published situation title, question, stored diagnosis and recorded outcome: at most 10 hits, creation time descending with id descending as a stable tie-breaker. The exact tenant predicate and identity join match `situation.list`'s existing tenant-reader policy, including humans, agents and read-only OAuth. These are already tenant-readable published reports, not private assistant threads or an extension of channel/mailbox authority. Nullable outcomes do not exclude unresolved reports. Snippets identify question/diagnosis/recorded outcome context where it fits; they remain bounded excerpts, not verified facts or instructions. Creation timestamps are not outcome-update or ingestion watermarks. `/situations?s=<encoded id>` resolves an exact tenant-readable selection even outside the latest-100 rail, without enlarging that rail or revealing other tenants.

Matching is the existing case-insensitive all-term substring search. Only the first six whitespace-separated words of two or more characters are used; `coverage.terms_used` records those effective terms. `%` and `_` remain literal search characters, not wildcard authority.

Each `coverage.sources` entry gives `returned`, `limit`, `total_matches: null` and conservative `may_have_more`. Reaching a result cap means more matches **may** exist, not that they definitely do. Conversations also flag omitted readable channels or a reached per-channel hit cap, even if fewer than 15 messages were returned. Below-cap results describe only the searched fields/records, not universal absence.

## Not searched / unknown

Outbound mail, mail attachments, reviews, private assistant conversations, repository code and archived conversations are explicitly listed as not searched (`assistant conversations` is the fixed coverage label). This is a product implementation limit, not a list of hidden resources, a permission grant, or proof any such record exists. No new indexing or permission bypass was added. Situation search uses the existing tenant/creation-time index to order candidates; substring predicates can still scan many tenant rows. A result cap is not a database work bound or production-load benchmark.

Total matching records and source freshness remain unknown. Stored receive/update timestamps are not continuous-ingestion or synchronization watermarks. These reads are not an atomic cross-D1/DO snapshot. Source/query failure still fails the request rather than returning a misleading successful empty source. No new search-wide deadline, pagination, full-scan redesign or freshness ledger is claimed; those remain separate work (#108/#118/#119).

`search.query` MCP auditing records declared argument keys/outcome only, not search terms, forged-field values or returned evidence. Searching does not open model turns, change reports/outcomes, send mail or grant access. Existing human/agent/grant revocation checks still run at the transport/dispatcher boundary; a previously constructed fixture context is not a new authenticated HTTP request.

MCP's inert-data note remains before results; its text and the escaped browser page show coverage for both hits and zero hits. Initial browser guidance also names the limited searched sources. Existing `work.search` and `message.search` hit-only contracts are unchanged by this increment.

Regression tests: `test/search-situations.test.ts`, `test/search-coverage.test.ts`, `test/search.test.ts`, `test/mail-access.test.ts`. Situation cases cover all four fields/null outcomes, all-term/literal matching, bounded labelled snippets, tenant-before-cap ordering, exact/over/under limits, deterministic ties, humans/agents/read-only OAuth, current transport grant/member refusal, forged selectors, unsearched private assistant data, escaped browser/inert MCP, old exact selections and foreign-selection denial, repeated read-only report/model/mail state, keys-only auditing and source-error fail-closed behavior. Synthetic fixtures do not prove provider authentication, actual diagnoses, operator execution or live-load performance. Native Workers tests cover zero versus unknown, effective terms, exact/over/under caps, 41-readable-channel truncation, per-channel truncation below the global cap, agent-only visibility, other tenants and archives, API/MCP/browser parity, inert rendering and anonymous denials. Additional evidence-source indexing and performance work remain open; these tests are not a production-load benchmark.
