# Chat workspace increment (#131)

The signed-in hub offers chat links only for the caller's active organizations. On a tenant host, Chat is available in the main navigation and tab row at `/c`.

## Implemented

- Channel rail on discovery, channel, and thread views, sourced exclusively from `chat.conversations` (existing viewer/tenant access policy).
- Server-side channel discovery by slug, display name, or topic; archived channels stay out of active discovery.
- Channel topics, active-channel indication, unread badges, refresh links, accessible composer labels, and read-only presentation for readers.
- A viewer-bound read-marker divider and jump link for new top-level messages on the displayed page. Activity cursors are not message counts: edits still produce the channel unread badge but are not falsely labeled new messages. Roots with newer replies offer **New thread activity**, using the viewer's activity cursor to open unread/changed replies.
- Explicit disclosure that the channel lists top-level messages, not replies, and that marking read acknowledges hidden activity too. Paginated/budget-limited pages additionally warn that older messages may remain unread.
- Thread views distinguish the original message from replies, with continuation headings; stale compose notices accurately describe potentially partial refreshed views.
- Explicit same-origin POST to `chat.mark_read`, bound to the viewer and channel, through the head shown on the form. GETs never move the cursor: a page can be partial, and opening one thread does not imply reading all channel activity. The control intentionally says **Mark channel read through #N**, not “mark these messages read.”
- Thread replies and forward pagination using the existing authoritative `next_after` cursor, with the thread root retained on continuation pages.
- Responsive one-column small-screen layout and wrapping for long message text, channel names and topics (including discovery cards). No new message HTML/Markdown interpretation: bodies, names, topics, references, and drafts remain escaped text.
- Same-title generic page responses replace their content during workbench navigation. Channel discovery search, explicit Refresh, successful posts, mark-read and stale-draft responses no longer leave the previous view on screen. Explicitly keyed two-pane Docket lists still keep their DOM when an inspector opens.
- Channel creation and adding an operated agent remain behind the existing verb authorization. Readers see neither form nor a posting composer. No automatic joins, presence claims, or privilege changes.

## Regression evidence

`test/chat-pages.test.ts` covers tenant discovery isolation, denied outside-tenant access, query/topic/body escaping, reader denials, same-origin unread acknowledgement, per-viewer cursor isolation, subsequent unread activity, hub organization links, stale drafts, large-thread continuation, viewer-specific unread dividers, edits versus new messages, hidden reply activity, and partial-page disclosure. Existing chat access, channel, conversation and UI-shell tests also run.

## Browser acceptance and reproduction

`npm run test:browser:chat` runs a real Chromium browser against a freshly bundled product Worker in disposable Miniflare D1/KV/SQLite Durable Objects. Install the browser first with `npx playwright install chromium` (and its OS libraries if needed). No remote bindings, real accounts, credential files or production cookies are used. Synthetic local memberships/sessions are inserted only in memory; ordinary product verbs and authorization handle the browser requests. All browser and Worker outbound network access is blocked. A temporary test-only entry recovers the synthetic host from Miniflare's loopback Host rewrite; it is never part of a deployed bundle and does not bypass authentication.

```sh
npm ci --ignore-scripts
npx playwright install chromium
CHAT_BROWSER_ARTIFACTS=/tmp/pimwell-chat-acceptance npm run test:browser:chat
```

The harness exercises discovery, channel and thread views at 1440×1000, 390×844 and 320×740, checking actual browser geometry for horizontal overflow and rail placement. Keyboard Tab/Enter paths reach discovery search, thread links, reply textarea and submit with visible focus outlines. It checks inert markup, same-title search/refresh, stale draft preservation with activity from a different author, successful reply display, explicit unread acknowledgement, GET cursor preservation, reader presentation, per-viewer cursor isolation and outside-tenant/unauthenticated denials. It also checks that opening a Docket inspector retains the explicitly keyed list DOM.

On 2026-10-09 the harness passed at all three sizes, and generated discovery/channel/thread-composer screenshots were visually inspected: desktop side-by-side rail, mobile stacked rail, wrapped inert text, thread context, accessible composer and persistent Chat tab. The harness first reproduced both the unbroken-topic overflow and same-title stale-view bugs; both are fixed. Screenshots are synthetic, saved outside Git in the selected artifact directory (or a temporary directory printed on completion), while test storage/builds are removed in `finally`. The existing worker tests cover large-thread continuation and tenant/channel/CSRF boundaries. This is real local authenticated browser acceptance, not a claim of an authenticated production login or testing every browser engine/device.

## Scope

This is a server-rendered incremental workspace, not a live WebSocket client. Message refresh remains explicit. Presence and worker participation are separate #132/#133 work; their current code may appear on the chat page, but this acceptance does not establish all of their requirements. Current tools expose replay-safe chat posting, but this worker has no discovered authorized channels; progress is recorded on work items rather than joining or guessing a channel.
