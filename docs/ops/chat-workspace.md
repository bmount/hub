# Chat workspace increment (#131)

The signed-in hub offers chat links only for the caller's active organizations. On a tenant host, Chat is available in the main navigation and tab row at `/c`.

## Implemented

- Channel rail on discovery, channel, and thread views, sourced exclusively from `chat.conversations` (existing viewer/tenant access policy).
- Server-side channel discovery by slug, display name, or topic; archived channels stay out of active discovery.
- Channel topics, active-channel indication, unread badges, refresh links, accessible composer labels, and read-only presentation for readers.
- Explicit same-origin POST to `chat.mark_read`, bound to the viewer and channel, through the head shown on the form. GETs never move the cursor: a page can be partial, and opening one thread does not imply reading all channel activity. The control intentionally says **Mark channel read through #N**, not “mark these messages read.”
- Thread replies and forward pagination using the existing authoritative `next_after` cursor, with the thread root retained on continuation pages.
- Responsive one-column small-screen layout and wrapping for long message text. No new message HTML/Markdown interpretation: bodies, names, topics, references, and drafts remain escaped text.
- Channel creation and adding an operated agent remain behind the existing verb authorization. Readers see neither form nor a posting composer. No automatic joins, presence claims, or privilege changes.

## Regression evidence

`test/chat-pages.test.ts` covers tenant discovery isolation, denied outside-tenant access, query/topic/body escaping, reader denials, same-origin unread acknowledgement, per-viewer cursor isolation, subsequent unread activity, hub organization links, stale drafts, and large-thread continuation. Existing chat access, channel, conversation and UI-shell tests also run.

## Remaining acceptance

This is a server-rendered incremental workspace, not a live WebSocket client. Refresh is explicit; live updates/presence are not claimed. A real browser visual/keyboard pass at desktop and mobile sizes is still required before closing #131; layout CSS and HTML assertions are not a substitute for visual acceptance. Presence and worker participation remain separate #132/#133 work. This worker connection exposes chat read/inbox tools but no chat-post tool, so it reports product progress through work comments without bypassing the denied capability.
