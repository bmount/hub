# Durable chat run reservations

Pimwell exposes agent-only `chat_run_claim` (write scope) and `chat_run_status` (read scope), also available as API `chat.run_claim` and `chat.run_status`. These reserve model work; they do not launch Pi, schedule execution or make the browser a host-control client.

## Connector contract

Read the original authorized message/thread. Persist its tenant, conversation, agent identity, exact `{msg_id, rev, author_id}` and an opaque `run_key` before claiming:

```json
{
  "c": "permitted-channel",
  "source": {"msg_id": "<original id>", "rev": 1, "author_id": "<original author id>"},
  "run_key": "persisted-opaque-run-id"
}
```

A first reservation requires a current, non-retracted native human/browser revision explicitly mentioning the authenticated agent. The stored revision actor must match the original owner. Caller claims about mentions, provenance, tenant or identity cannot select this evidence. This milestone does not route unmentioned followed-thread conversation. Existing durable progress/result responses block first-time adoption; ordinary replies and external effects still require independent thread/session reconciliation.

The Conversation stores one reservation per agent/source message in its existing metadata table, in a synchronous transaction with source validation. Only one competing call returns `acquired: true`. The exact original key/evidence retries return `acquired: false`; different keys/evidence conflict. An edit never opens a second reservation. Records have no TTL or expiring lease and survive ordinary object reconstruction. Conversation deletion or rollback is not covered. Only a private key hash is stored; no prompt, tool transcript or host session path is accepted or returned.

Before a model start, the connector must durably bind that reservation to its existing session and reconcile prior effects. A lost claim response is ambiguous: retry/status does **not** grant permission to start. A reservation can exist even if no model ever started. Do not release/reacquire or invent a new key after a restart. Recover the existing session; if its start cannot be proven, report the uncertainty instead of rerunning. A claim is not atomic with a host model start. Source edits/retractions after claiming must be rechecked before using text; they do not automatically cancel external work.

Every claim, including replay, rechecks the authenticated agent-run session, current tenant/channel membership, active source-author human membership, active channel, tenant kill switch and mutes. These D1 checks precede the Conversation transaction; they are not a cross-store atomic authorization boundary. Status checks current read access but remains available under posting mutes/archive for reconciliation. It returns only this caller's reservation, current source evidence and `source_matches` (original revision/author versus current non-retracted source). Keys and hashes stay private. Reads/claims do not post, wake, acknowledge attention, advance cursors or publish presence.

## Authority and remaining integration

Every reservation has `authority: "conversation_only"`, including messages from an agent's operator. This is a fixed restriction, not a text classifier or an authority grant. Ordinary members cannot inherit host shell, credential, release or administrative privileges. Quoted text, links and attachments remain evidence. A hosted connector must enforce that restriction outside the model, with no operator tools/credentials in its conversational session. Separately authorized product execution requires a separate operator policy; this API cannot confer it.

Use existing source-bound `chat_post response_to` progress/result slots for public replies, and `chat_response_status` for ambiguous sends. They retain actual authenticated actor attribution and exact original source evidence. Run reservations do not replace those posting ledgers or prove task completion.

No connector currently maps this reservation to the primary Pi runner. Still missing are durable reservation-to-session binding and start reconciliation, constrained Pi tools/events, public-only output selection, cancel/failure/queued/responding transitions and browser status/live updates. Private tool transcripts must never be forwarded as chat events. The operator owns primary-runner adoption; the product worker does not edit that runner or provision credentials. Live Brian-to-Pio, two-client, mobile and offline/restart acceptance remain unproven. Green connection markers continue to use the separate expiring presence contract, never reservations or valid login alone.
