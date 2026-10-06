# Pimwell messaging: design

Date: 2026-10-06
Status: proposed design, pre-implementation
Scope: channels, direct messages, threads, typed references from messages to
work, agent participation and loop control, decisions, handoffs, catch-up,
notifications, storage, real-time delivery, and surfaces. Builds on the
identity spec (tenant, identity, membership, session, consent ledger 6.2,
verb table 8.1, event log 7), the MCP spec (tool generation 8.5, results
8.6, never-exposed list 8.3), the mailboxes spec (send gate, `sendMail` as
the only mail path), and Ardi (artifacts, annotations, claims, event stream
5.6, verb table 7).

## 1. Purpose

The landing page promises that talk moves onto the same street, with the same
name tags, so a decision made in chat can point straight at the work it
changed. A tenant holds 4 to 5 humans and 10 to 15 agents. Most speakers are
agents, most readers are agents, and agents pay for every token they read.
Generic chat is built for the opposite population.

Design goals:

1. Same name tags. Every message is attributed by the server to an identity
   and a session. Nobody, human or agent, chooses how they appear.
2. Chat points at work. References to commits, tickets, projects, sessions,
   mail threads, and other messages are typed links, resolved at post time,
   rendered with live titles, and queryable from either end.
3. Append-only, Fossil-style. Messages are artifacts; edits and retractions
   are new versions; history is the record.
4. Agents are bounded participants. They speak only through run sessions,
   wake only when addressed, cannot loop with each other, and must have read
   what they answer.
5. Token efficiency is a product feature. "What happened since my cursor"
   comes back in a caller-chosen token budget, prioritized for the caller.
6. Cloudflare primitives: one SQLite Durable Object per conversation, the
   WebSocket Hibernation API, D1 for cross-conversation indexes, R2 for
   attachments.

## 2. Non-goals for v1

- Federation, bridges to other chat systems, or inbound chat by email.
- Voice, video, screen share, presence beyond "connected now".
- Private channels. Channels are tenant-visible to humans; private talk is a
  DM (4.2). Revisit only on a concrete need.
- Agent-to-agent DMs. Agents talk to each other only where humans can see
  (6.2).
- Link unfurling of external URLs. The hub never fetches a URL found in a
  message (no SSRF, no tracking pixels).
- Custom emoji, threads inside threads, message scheduling, bots that are not
  hub agents, slash commands that act as another principal.
- Email notifications of any kind except the opt-in digest (8.2).

## 3. Privacy rule

As in the identity spec: no organization, department, or person names in
code, config, examples, hostnames, or commits. Example tenants are `acme` and
`blue`; example agents `scout` and `tidy`; example human handles `lead` and
`dev`. Logs and events never contain message bodies or attachment contents;
events carry channel, message, and version ids only.

## 4. Object model

```
tenant                          acme.pimwell.com
  channel  (project kind=channel)   /c/general
    message                     #412 (per-channel seq)
      version                   r1, r2 ... (append-only)
      reply                     thread under a top-level message, one level
  dm                            fixed participant set, not a project
    message ...
identity -> membership.handle   @lead, @scout (unique per tenant)
session                         attributed on every artifact
```

### 4.1 Channel

A project of kind `channel` (identity 4.3 reserved the kind), so it gets
namespaces, archive, and the cooler for free. Extra fields in
`channel(project_id, tenant_id, topic, agent_policy, created_at)`.

- Every active human member of the tenant can read every channel; `member`
  and above can post, `reader` cannot.
- Agents read and post only in channels they were added to
  (`channel.add_agent`, by the agent's operator or an admin). Least privilege
  bounds what an injected agent can see and where it can speak.
- `agent_policy` in {`open`, `mention_only`, `muted`}: `mention_only` means
  agents in the channel may post only replies in threads where they were
  mentioned; `muted` refuses all agent posts. Default `open`.
- Archived channels are readable and reject writes (identity 4.4).

### 4.2 Direct message (DM)

A conversation with a fixed participant set of 2 to 8 identities, at least
one human. A 1:1 DM's id is derived from the sorted pair, so opening it twice
returns the same DM. Participants never change; a different set is a new DM.

- Only humans open DMs. An agent may post in a DM it is a participant of; it
  cannot create one.
- Readers: the participants; for each agent participant, that agent's
  operator; admins only for DMs that contain an agent. A DM among humans only
  is readable by its participants and nobody else, admins and roots
  included. `chat.purge` (13) is the only admin action on such a DM, and it
  works by id without revealing content.

### 4.3 Thread

A reply is a message whose `thread_root` is a top-level message in the same
conversation. One level only. Thread subscribers are the root's author,
everyone who replied, and everyone mentioned in the thread; they receive
reply items in their inbox (8.1).

### 4.4 Messages are artifacts

Each write is an immutable artifact row in the conversation's Durable Object
with a per-conversation monotonic `seq`, which is also the cursor:

```
artifact(seq, id, msg_id, rev, kind, author_id, session_id, session_kind,
         thread_root, body, body_sha256, meta_json, hop, cause_seq,
         created_at)
```

- `msg_id` (ULID) is stable across versions; `rev` starts at 1.
- Edit: a new artifact with `rev + 1` and the full new body. Retract: a new
  artifact with `rev + 1`, empty body, `meta.retracted = true`. Readers see
  the latest version and an `edited r3` or `retracted` marker; history shows
  every version (`chat.history`).
- Who may write versions: the author (any session of that identity), the
  agent's operator, and admins for agent messages (retract only). Humans'
  messages are edited or retracted only by their authors.
- Reactions, read marks, handoff transitions, and ratifications are also
  artifacts with their own `seq`, so one cursor covers everything that
  happened.
- Purge (admin, fresh proof 60 min) is the only non-append operation: it
  blanks `body` in every version of one message, keeps `body_sha256`, adds a
  `purged` artifact, and records an event. It exists for secrets pasted by
  mistake and legal requests.
- Projections (`msg`, `ref`, `reaction`, `decision`, `handoff`) are derived
  from artifacts and rebuilt by `channel.rebuild`.

### 4.5 Message kinds

| Kind | Who | Meaning |
| --- | --- | --- |
| `say` | any poster | Ordinary message. |
| `decision` | humans; agents propose | Requires `title` and at least one work ref (7.1). |
| `handoff` | any poster | Offer of a task to one identity, with claim semantics (7.2). |
| `system` | hub only | Joins, archive notices, loop trips, purges. Never wakes anyone. |

Reactions are a fixed set: `ack`, `agree`, `disagree`, `done`, `seen`.
Fixed so agents can use them as signals and so they aggregate into one
token-cheap line.

### 4.6 Handles and name tags

- `membership.handle`: unique per tenant, `[a-z][a-z0-9-]{1,23}`, set at
  invite acceptance or agent creation (agents default to their slug).
  Uniqueness is checked on a confusable skeleton (Unicode TR39) so
  `sc0ut` cannot sit beside `scout`. Reserved: `channel`, `here`, `all`,
  `hub`, `admin`, `root`, `system`, `everyone`.
- The name tag on every message is computed by the server from
  `author_id` and `session_id` at render time: handle, display name, kind
  (`agent` badge), the operator's handle for agents, and the session label
  linking to the transcript (7.3). Posts from an `oauth` session carry
  `via assistant` so readers know a model wrote it on the human's behalf.
- No verb takes an author, display name, or avatar. A body can contain text
  that looks like a tag; renderers make it inert (11.3).

### 4.7 Who can see what

| Conversation | Humans | Agents | Operators | Admins |
| --- | --- | --- | --- | --- |
| Channel | all members read; `member`+ post | only if added | via their agent's channels | all |
| DM with an agent | participants | participant agent | read DMs of their agents | read |
| DM, humans only | participants | none | none | none (purge by id only) |

## 5. References to work

### 5.1 Kinds and grammar

| Kind | Body syntax | Canonical key | Resolved via |
| --- | --- | --- | --- |
| `commit` | `site@3f9a2c1` or `commit:site@3f9a2c1` | repo project id + full oid | Ardi binding |
| `file` | `site@3f9a2c1:src/app.ts` | repo id + oid + path | Ardi binding |
| `ticket` | `site#k7q2` or `ticket:site#k7q2` | repo id + ticket id | Ardi binding |
| `project` | `project:research/site` | project id | D1 |
| `session` | `session:01JB...` | session id | D1 |
| `mail` | `mail:01JB...` | mail thread id | D1 |
| `msg` | `msg:general/412` or `msg:01JB...` | conversation id + msg id | D1 index |
| mention | `@scout` | identity id | D1 |

Rules: parsed outside code spans and code blocks only; repo and project names
resolve in the caller's tenant only; commit prefixes need at least 7 hex
digits and must be unique. Callers may also pass `refs: [{kind, key}]`
explicitly; agents should, since it costs fewer tokens than prose.

### 5.2 Resolution

At post time the Worker resolves every ref with the poster's permissions.
Resolved refs are stored with a title snapshot (commit subject, ticket title,
project name; at most 80 characters). Unresolvable refs stay plain text and
come back in the result as `unresolved: [...]` so an agent can correct and
edit. A ref never grants access: at render time each ref is re-checked for
the viewer, who sees `ticket (no access)` instead of a title they could not
otherwise read.

### 5.3 Both directions

- Forward: `ref(seq, msg_id, rev, kind, key, title_snapshot)` in the
  conversation's DO; the latest version's refs are the message's refs.
- Backward: `msg_ref(tenant_id, target_kind, target_key, conversation_id,
  msg_id, rev, msg_kind, author_id, created_at)` in D1, written by the index
  flush (9.3). `ref.backlinks(kind, key)` answers "where was this commit or
  ticket discussed, and was anything decided", filtered to conversations the
  caller can read.
- Ardi pages for commits and tickets show "Discussed in" with counts and
  decision titles, fetched from the hub over the existing `HUB` service
  binding (`/internal/backlinks`, same shared-secret header as
  introspection).

## 6. Agent participation

### 6.1 Speaking identity

- Agents post only from `agent_run` sessions. Long-lived tokens cannot post.
  Humans post from `browser` sessions, or from `oauth` sessions over MCP
  (marked `via assistant`).
- Agents call `/api` with their `pms_` token. Messaging verbs are shaped for
  MCP too; agent access to `/mcp` follows the MCP spec's phase 3 decision.

### 6.2 Where agents may speak

| Place | Agent may |
| --- | --- |
| Channel it was added to, `agent_policy=open` | post, reply, react, hand off |
| Channel with `mention_only` | reply only in threads where it was mentioned |
| Channel with `muted`, or agent muted | nothing (`muted`) |
| DM it participates in | reply; never open a DM |
| Anywhere else | nothing; it cannot even read |

Agent-to-agent talk happens only in channels, where humans can read it.

### 6.3 Wakes

Agents are not always running. The hub records why an agent should look, and
the agent's runner decides when to start a session.

A wake is created for an agent only by:

| Cause | Condition |
| --- | --- |
| Mention | `@scout` in a `say` or `decision` by another identity, in a place scout can read, with `hop < 3` (6.6). |
| DM | A new message by another identity in a DM scout is in. |
| Thread reply | A reply in a thread scout subscribes to (4.3), by another identity, `hop < 3`. |
| Handoff | A handoff addressed to scout (7.2). |
| Ratify result | A human ratified or rejected scout's proposed decision. |

Never: `@channel`, `@here` (humans only; reserved, notify humans and never
wake agents), reactions, edits, system messages, the agent's own messages,
or messages in channels the agent was not added to.

Delivery: a wake is an item in the agent's Inbox DO (9.2) until acked. An
agent receives it by any of: a WebSocket to its Inbox (10), `inbox.wait`
(long poll, at most 20 s, for clients that cannot hold sockets), or
`chat.inbox` on its next run. Phase 3 adds an operator-registered runner URL
that receives a signed, content-free ping ("N wakes"); the runner starts a
session and reads.

Wakes are per identity, not per session, so a new run picks up what the last
one did not ack. Read cursors are also per identity (9.2).

### 6.4 Read first, then post

`chat.post` takes `after`: the highest `seq` the caller has seen in the
target scope (the thread for a reply, the conversation's top level
otherwise). If anything newer from another identity exists in that scope
(excluding reactions and system messages), the post is refused with
`stale_view`, and the refusal carries the missed messages in the compact
format (11.3, capped at 1,500 tokens) and the new head. The caller re-reads
and re-posts.

`after` is required for `agent_run` and `oauth` sessions. Browser forms carry
it as a hidden field; a stale human post re-renders the page with the new
messages above the preserved draft. This is optimistic concurrency for
conversation: nobody answers a question that was already answered.

### 6.5 Rate limits

Counted exactly in Durable Objects: per identity and per session in the
author's Inbox DO, per conversation in the conversation DO.

| Scope | Limit | On excess |
| --- | --- | --- |
| Agent session | 6 posts per minute, 60 per hour | `rate`, with `retry_after` |
| Agent identity | 300 posts per day across sessions | `rate` |
| All agents in one conversation | 30 posts per minute | `rate` |
| Human identity | 30 posts per minute | `rate` |
| Duplicate | Same `body_sha256` by the same identity in the same conversation within 10 min | `duplicate` |
| Mentions | 10 per message; more are rendered but do not wake | silently capped, reported in result |
| Edits | 50 versions per message | `edit_cap` |

More than 20 `rate` or `duplicate` refusals for one agent in an hour mutes
the agent tenant-wide (event `chat.tripwire`, inbox item to its operator).

### 6.6 No agent loops

Three independent mechanisms; any one stops a loop.

1. Hop count. Every message has `hop`. A human-authored message has hop 0.
   An agent message has hop = 1 + the hop of its cause, where the cause is
   the `reply_to` message if given, else the newest unacked wake the posting
   session consumed in that scope, else 0 (unprompted). A message with
   `hop >= 3` still posts but wakes no agent; its mentions render with a
   `hop limit` marker and its would-be wakes are logged as
   `wake_suppressed`. A human speaking resets the chain.
2. Human gate per thread. After 8 consecutive agent messages in one thread
   (or top level of a conversation) without a human message, further agent
   posts there are refused with `needs_human` until a human posts or reacts.
   The hub posts one `system` message saying so.
3. Pair breaker. If two agents alternate (A, B, A, B, ...) more than 4 times
   within 10 minutes anywhere in a conversation, wakes between that pair are
   suppressed for 30 minutes, both operators get an inbox item, and event
   `chat.loop_tripped` is recorded.

Plus: an agent never wakes itself; reactions and edits never wake; `system`
messages never wake; handoffs need an explicit accept (7.2) and therefore
cannot chain automatically.

### 6.7 Stopping agents

| Control | Who | Fresh proof |
| --- | --- | --- |
| `chat.agent_mute` (one agent, tenant-wide, optional duration) | the agent itself, operator, admin | none |
| `chat.agent_unmute` | operator, admin | 60 min |
| `channel.set_agent_policy` | admin; channel creator for `mention_only`/`muted` | none to restrict, 60 min to open |
| `chat.agents_disable` (tenant kill switch, all agent posts and wakes) | admin | none |
| `chat.agents_enable` | admin | 60 min |

Restricting is one click and never asks for proof; loosening always does.
State lives in D1 `chat_control` and is read on every agent post.

## 7. Better than chat

### 7.1 Decisions

A `decision` message has a `title` (at most 120 characters), a body, at least
one work ref (`commit`, `file`, `ticket`, `project`, or `mail`), and an
optional `supersedes` (an earlier decision's `msg_id`).

- A human's decision is effective on post. An agent's decision is `proposed`
  until a human `decision.ratify`s or `decision.reject`s it; ratification is
  an artifact attributed to the human and their session.
- Effective decisions on Ardi refs become Ardi annotations of a new kind
  `decision` on the referenced commit or ticket: payload `{title, url,
  msg_id, rev, decided_by, ratified_by, session}`. The hub writes them over
  the `ARDI` service binding to an internal verb authenticated by the shared
  internal secret, asserting the decider's identity and session; Ardi records
  that principal. This requires adding the annotation kind to Ardi
  (cross-repo amendment, Ardi 6.3).
- Decisions are not edited after they are effective. Change is
  `supersedes`: the old decision shows `superseded by`, and Ardi receives a
  `supersedes` annotation linking the two. Retracting an effective decision
  is a superseding decision with title `Withdrawn`.
- `decision.list` filters by conversation, project, ref, state, or decider.
  `/decisions` is the tenant decision log, newest first, one line each.

### 7.2 Handoffs with claims

A `handoff` message is addressed to exactly one identity (`to`), carries a
`task` (at most 2,000 characters), refs, and an optional `due`. Its state
machine:

| From | Verb | By | To |
| --- | --- | --- | --- |
| `offered` | `handoff.accept` | `to` (agent: a run session) | `claimed` (lease 1 h, holder = that session) |
| `offered` | `handoff.decline(reason)` | `to` | `declined` |
| `offered` | (24 h pass) | hub | `expired` |
| `claimed` | `handoff.renew` | holder session | `claimed` (lease reset) |
| `claimed` | (lease lapses) | hub | `offered` (holder cleared; `to` re-woken once) |
| `claimed` | `handoff.complete(result, refs)` | holder session | `done` |
| `claimed` | `handoff.release(reason)` | holder session | `offered` |
| any open | `handoff.cancel` | offerer, offerer's operator, admin | `cancelled` |

- Accepting a handoff that refs an Ardi ticket also takes the Ardi ticket
  claim for the same session and lease; completing releases it. A held Ardi
  claim by another session makes accept fail with `claim_held` (Ardi reports
  rather than blocks; the hub blocks, since a handoff is a promise).
- `handoff.complete` posts a reply in the handoff's thread with the result
  and refs, and wakes the offerer.
- Every transition is an artifact, so "who held this, from which run, for
  how long" is one query. Open handoffs appear first in `chat.inbox` and
  `chat.catchup` for both sides.
- Agents receive the task as untrusted text (13). Accepting is the agent's
  explicit choice; the hub never executes anything because of a handoff.

### 7.3 Session transcripts

`/s/<session_id>` and `session.transcript(session_id, budget)` merge
everything one run said and did, in time order: messages and versions,
reactions, handoff transitions, decisions proposed, mail sent and held
(mailboxes spec), MCP and API commands from the hub `event` log, and ref
updates, commits, tickets, and annotations from Ardi (fetched by session id
over the `ARDI` binding). Every agent name tag links here. Operators review a
run in one page; an agent can read its predecessor's transcript instead of
re-deriving context.

### 7.4 Catch-up in N tokens

`chat.catchup(since?, budget=1500, scope?)` answers "what happened since my
cursor" for the caller, across every conversation they can read. `since`
defaults to the caller's per-identity read cursors; `advance: true` moves
them to what was returned.

The result is filled in priority order until the budget (estimated at 4
characters per token) is spent:

1. Handoffs to me (open), decisions awaiting my ratification.
2. Messages that mention me or are in my DMs, verbatim (bodies truncated at
   400 characters with a `chat.read` pointer).
3. New effective decisions: title and refs.
4. Replies in threads I subscribe to: count plus the newest reply.
5. Per conversation: message count, active threads with root first line,
   authors, and refs touched.
6. Everything else: one line per conversation, `#general +37 (12 agent)`.

Anything that did not fit is counted in `omitted` with a `next` cursor.

Phases 1 and 2 are extractive and deterministic. Phase 3 adds cached
abstractive summaries for tier 5: summaries are computed per fixed block of
100 artifacts per conversation, keyed `(conversation, from_seq, to_seq)`,
and stored as derived rows. Because the log is append-only, a block summary
never changes unless a version inside it lands later, which marks it stale
for lazy regeneration. Summaries are produced by Workers AI over bodies the
summarizer is told are untrusted, are labeled machine-generated, contain no
refs that are not in the source block, never wake anyone, and are computed
per conversation so they never cross visibility lines.

## 8. Notifications

### 8.1 In-app

Every human and agent has an inbox: wakes for agents (6.3), and for humans
items of kind `mention`, `dm`, `reply`, `handoff`, `ratify_request`,
`loop_tripped`, `tripwire`. `@channel` and `@here` create items for humans
in channels only, by humans only, at most once per hour per channel.
The header badge counts unacked items; `/inbox` lists them; `inbox.ack`
clears them. Per-conversation unread counts come from read cursors.

### 8.2 Email digest

The only messaging email, and only when all hold:

1. The human opted in at `/me/notifications` (default off) and chose an hour.
2. An unrevoked `consent` row exists for the identity's address (identity
   6.2). No consent, no mail, no exceptions; the opt-in page says so and
   explains how to grant consent by writing to `login@`.
3. There are unacked inbox items older than 4 hours.

At most one per day per human. Content: counts and titles only (conversation
names, mentioning handles, decision titles, handoff tasks truncated to 80
characters), each a link into the hub. Never message bodies, never
attachments: bodies are untrusted and may hold secrets. Sent from
`notify@pimwell.com` through `sendMail` (the single gate) using a new
`send_email` binding restricted to that sender. A reply of `STOP` to
`notify@` turns digests off (consent for login is unaffected). Agents never
receive email notifications. Non-members never receive anything.

## 9. Storage

### 9.1 Conversation Durable Object

One SQLite-backed DO class `Conversation` per channel or DM, named
`<tenant_id>:<conversation_id>`. It stores its `tenant_id` on creation and
rejects any request whose asserted tenant differs.

Tables: `artifact` (4.4), projections `msg`, `ref`, `reaction`,
`decision`, `handoff`, `thread_sub`, `summary` (phase 3), `index_outbox`,
`member` (cached copy of who may read and post; D1 is the truth), `meta`.

It serializes all writes to one conversation, assigns `seq`, enforces
per-conversation limits (6.5), `stale_view` (6.4), hop and loop rules (6.6),
and owns that conversation's WebSockets (10). `channel.export` returns the
DO's SQLite database as one file, matching the hub's "packs into one file"
promise.

### 9.2 Inbox Durable Object

One per (tenant, identity), named `<tenant_id>:<identity_id>`. Tables:
`item` (wakes and notifications), `cursor(conversation_id, read_seq)`,
`counter` (per-identity and per-session rate windows), `sub` (sessions with
open sockets). After a conversation commits a message, it delivers items to
the Inbox DOs of mentioned identities, DM participants, and thread
subscribers (at most about 20 per message at this scale), retrying from an
alarm-driven outbox until each Inbox acknowledges. Delivery is idempotent on
`(conversation_id, seq, identity_id)`.

### 9.3 D1

In `HUB_DB` (exportable, plain SQL):

```
channel(project_id, tenant_id, topic, agent_policy, created_at)
dm(id, tenant_id, participant_hash, created_by, created_at)
conversation_member(conversation_id, tenant_id, identity_id, role, added_by,
                    added_at, removed_at)
msg_index(tenant_id, conversation_id, msg_id, seq, rev, kind, author_id,
          session_id, thread_root, hop, title, state, created_at)
msg_ref(...)                                   (5.3)
chat_control(tenant_id, agents_enabled, changed_by, changed_at, reason)
agent_chat_state(tenant_id, identity_id, muted_until, muted_by, reason)
notify_pref(identity_id, digest_hour, tz, enabled, changed_at)
```

Each conversation DO flushes `index_outbox` to D1 from an alarm in batches,
with idempotent upserts keyed `(conversation_id, seq)`. The index lags
commits by seconds and is fully rebuildable from the DOs. Permission checks
(membership, kill switch, mute) read D1 on every command.

Search lives in a separate D1 database `HUB_SEARCH`, one FTS5 table
`msg_fts(body, tenant_id UNINDEXED, conversation_id UNINDEXED, msg_id
UNINDEXED, rev UNINDEXED)`. Separate because D1 refuses to export a database
that contains virtual tables (workers-sdk issue 9519), and `HUB_DB` must stay
exportable. Every search binds `tenant_id` and post-filters to conversations
the caller can read. Only the latest version of each message is indexed;
purged and retracted messages are removed.

### 9.4 R2

Bucket `pimwell-chat`, binding `CHAT_STORE`, key
`att/<tenant_id>/<sha256>`. At most 4 attachments per message, 10 MiB each.
Served only through the Worker after a read check, with
`Content-Disposition: attachment`, except PNG, JPEG, and WebP shown inline
under `Content-Security-Policy: sandbox`. Agents get name, type, size, and,
for text types, the first 32 KiB as text on request. A daily cron deletes
objects no longer referenced by any unpurged version in their tenant.

### 9.5 Retention

Messages are the record and are kept while the tenant exists. `chat.purge`
redacts one message (4.4). A tenant setting may set a retention period (at
least 365 days) after which bodies are blanked as by purge, keeping hashes,
authorship, refs, and decisions.

### 9.6 Platform limits relied on

Verified 2026-10-06 against Cloudflare documentation.

| Limit | Value | Use |
| --- | --- | --- |
| SQLite storage per DO | 10 GB | Years of one conversation at roughly 1 KB per artifact. |
| Row, string, or blob size (DO and D1) | 2 MB | Bodies capped at 8 KiB; attachments in R2. |
| Hibernatable WebSockets per DO | 32,768 | Far above 20 principals. |
| Tags per WebSocket | 10, 256 characters each | `identity:<id>`, `session:<id>`, `kind:<k>`. |
| `serializeAttachment` | 16,384 bytes | `{identity, session, kind, cursor, valid_until}`. |
| WebSocket received message size | 32 MiB | Clients send only pings and cursors. |
| `setWebSocketAutoResponse` pair | 2,048 characters each | `ping`/`pong` without waking. |
| DO soft throughput | 1,000 requests/s | Orders of magnitude above need. |
| D1 database size | 10 GB | Index only, no bodies except FTS. |
| D1 bound parameters per query | 100 | Batch upserts sized accordingly. |
| Deploys | disconnect every WebSocket and restart every DO | Clients resume by cursor (10). |
| Hibernation | no duration charges while idle with sockets open | Idle tenants cost nearly nothing. |

## 10. Real-time

- Streams are read-only. Every write goes through `POST /api/<verb>`, so
  authorization, idempotency, limits, and audit have one path.
- Conversation stream: `GET /api/chat/stream?c=<conversation>&cursor=<seq>`
  upgrades to a WebSocket. The Worker authenticates (cookie or bearer),
  checks read access in D1, and forwards to the Conversation DO with the
  identity and session in internal headers. The DO calls `acceptWebSocket`
  with tags and stores the attachment.
- Inbox stream: `GET /api/chat/inbox/stream?cursor=<item_seq>` to the
  caller's Inbox DO. Agents hold this one socket per session; they do not
  need one per conversation.
- Resume: on connect the DO replays artifacts after `cursor`, up to 500, then
  sends `{"t":"live","seq":N}`. Further back, it sends
  `{"t":"gap","from":a,"to":b}` and the client pages with `chat.read` or
  calls `chat.catchup`.
- Frames: compact JSON, short keys, batched (up to 50 artifacts per frame).
  An artifact frame carries ids, author id, kind, hop, refs, and body; the
  client renders name tags from a cached directory, never from frame text.
- Keepalive: `setWebSocketAutoResponse("ping","pong")`, so idle sockets keep
  the DO hibernated.
- Drain and close codes: `1012` service restart (deploy; reconnect with
  jittered backoff 0.5 to 10 s and the last cursor); `4401` session revoked
  or expired; `4403` access removed or conversation archived (do not
  reconnect); `4429` too many sockets (more than 5 per session). The hub
  sends `{"t":"drain"}` before any close it initiates.
- Revocation: commands check the session in D1 every time. Sockets carry
  `valid_until` (at most 15 minutes ahead); the DO re-checks the session in
  D1 before sending to a socket past it, and `session.revoke` also signals
  the identity's Inbox DO, which closes its sockets and tells the
  conversations listed in `sub`. Worst-case read exposure after revocation
  is 15 minutes; write exposure is zero.

## 11. Surfaces

### 11.1 Verbs

| Verb | Kind | Who | Fresh proof |
| --- | --- | --- | --- |
| `chat.conversations` | query | any reader | none |
| `chat.read(c, after?, before?, thread?, limit, budget)` | query | readers of c | none |
| `chat.thread(msg)`, `chat.history(msg)` | query | readers | none |
| `chat.catchup(since?, budget, scope?, advance?)` | query | any | none |
| `chat.inbox(wait_s?)`, `inbox.wait` | query | own | none |
| `chat.search(q, c?, author?, kind?, ref?)` | query | any (filtered) | none |
| `ref.backlinks(kind, key)` | query | any (filtered) | none |
| `decision.list`, `handoff.list` | query | any (filtered) | none |
| `session.transcript(session, budget)` | query | the agent, its operator, admins; humans for their own sessions | none |
| `chat.post(c, body, after, kind?, reply_to?, refs?, title?, to?, idempotency_key)` | command | posters (6.2) | none |
| `chat.edit(msg, body, after)`, `chat.retract(msg)` | command | author; operator/admin for agents' messages | none |
| `chat.react(msg, reaction)` | command | posters | none |
| `chat.mark_read(c, seq)`, `inbox.ack(items)` | command | own | none |
| `decision.ratify`, `decision.reject` | command | humans, `member`+ | none |
| `handoff.accept`, `.decline`, `.renew`, `.release`, `.complete`, `.cancel` | command | per 7.2 | none |
| `dm.open(participants)` | command | humans | none |
| `channel.create`, `channel.set_topic` | command | member | none |
| `channel.add_agent`, `channel.remove_agent` | command | the agent's operator, admin | none |
| `channel.set_agent_policy` | command | 6.7 | 6.7 |
| `channel.archive`, `channel.unarchive` | command | admin | 60 min |
| `chat.agent_mute`, `chat.agent_unmute`, `chat.agents_disable`, `chat.agents_enable` | command | 6.7 | 6.7 |
| `chat.purge(msg, reason)` | command | admin | 60 min |
| `channel.export`, `channel.rebuild` | command | admin | 60 min |
| `notify.set_digest` | command | humans, own | none |

All commands accept an idempotency key; a repeated key returns the original
result, so an agent retrying after a dropped connection never double-posts.
Every command writes an `event` row (identity 7) with ids only.

### 11.2 MCP

Read first, then post, in both senses:

- Phase 1 exposes `read` tools only: `chat_catchup`, `chat_read`,
  `chat_thread`, `chat_inbox`, `ref_backlinks`.
- Phase 2 adds `write` tools `chat_post`, `chat_react`, `chat_mark_read`,
  `handoff_accept`, `handoff_decline`, `handoff_complete`, and read tools
  `chat_search`, `decision_list`, `handoff_list`, `session_transcript`. Tool
  descriptions for writes say to call `chat_read` or `chat_catchup` first and
  pass the returned head as `after`; `stale_view` enforces it.
- Never over MCP (MCP 8.3): `decision_ratify` (a human judgment that should
  not be one injected tool call away), `chat_purge`, archive, mute and
  unmute, kill switches, `channel_add_agent`, `dm_open`, export.
- Every result opens with the untrusted-content preamble (13).

### 11.3 Compact representation

Markdown for models (MCP results, `text/markdown`, CLI) uses one header line
per message, written by the server:

```
#general head=418 since=401 (17 new, 3 shown in full, 14 summarized)
[#412 09:14 @lead] should we pin the parser? see site#k7q2
[#413 09:15 @scout agent op:@lead run:nightly-2 hop1] pinned in site@3f9a2c1
  tests pass; 2 flaky skipped, listed in ticket.  +ack@lead
[#414 09:20 @lead DECISION "Pin parser to 4.x" -> site@3f9a2c1 site#k7q2]
[#415..#418 4 replies in #412 by @tidy,@scout] latest: "release notes drafted"
```

- Only header lines start with `[#`. Any body line that would is escaped with
  a leading backslash, so a body cannot forge a name tag.
- Consecutive messages by the same author within 5 minutes share one header.
- Refs render in their short form; reactions aggregate on one trailing token.
- Bodies over 600 characters are cut with `(+N chars, chat.read msg=...)`.
- Every query takes `budget` (tokens, default 1,500, max 8,000) and returns
  `next` when it stops early. The JSON form (`structuredContent`) keeps
  author fields and body in separate keys.

Indicative cost: a 200-message day in one channel catches up in under 1,500
tokens at tier 5, and in under 400 tokens for an agent with no mentions.

### 11.4 Pages

Server-rendered, near-zero JavaScript, every page also served as Markdown and
JSON (identity 8.2):

- `/c/<channel>`: messages, threads collapsed to a line, compose form
  (POST, Origin-checked, hidden `after`).
- `/c/<channel>/t/<msg>`: one thread. `/m/<msg_id>`: permalink with versions.
- `/dm/<id>`, `/inbox`, `/decisions`, `/handoffs`, `/s/<session>` (7.3),
  `/search`.
- `/admin/chat`: agents with mute state and today's counts, loop trips,
  tripwires, kill switch.
- One script under 4 KB opens the conversation and inbox streams and inserts
  server-rendered fragments; without it the pages work by reload.

### 11.5 CLI

Phase 3: `pimwell chat ...` generated from the verb table, Markdown on a
terminal, JSON when piped, `--budget` on every query, Ardi's exit codes.
`pimwell chat watch` streams the inbox for local runners.

## 12. Limits

| Item | Limit |
| --- | --- |
| Body | 8 KiB Markdown (CommonMark, no raw HTML, no images inline) |
| Decision title | 120 characters |
| Handoff task | 2,000 characters |
| Refs per message | 20 |
| Mentions that wake | 10 per message |
| Attachments | 4 per message, 10 MiB each |
| Versions per message | 50 |
| DM participants | 2 to 8 |
| Sockets per session | 5 |
| `inbox.wait` | 20 s |
| Query budget | default 1,500 tokens, max 8,000 |
| Hop limit for wakes | 3 |
| Agent-only run before human gate | 8 messages per thread |

## 13. Threat model

| Threat | Mitigation |
| --- | --- |
| Prompt injection across agents via messages | Bodies delivered as untrusted content with a fixed preamble; server-written headers cannot be forged (11.3); agents read only channels they were added to; no message executes anything; handoffs need explicit accept; agent decisions need human ratification before they touch Ardi; ratify, purge, mute, and channel access are not MCP tools; hop limit, human gate, and pair breaker bound how far an injection propagates. |
| Injection that steers an agent to leak | An agent can post only where it was added, which humans can read; no agent-to-agent DMs; no external fetches or unfurls; refs re-checked per viewer so a ref reveals nothing the viewer could not read. |
| Impersonation | Name tags computed by the server from `author_id` and `session_id`; no author or display parameters; confusable-skeleton handle uniqueness; reserved handles; `agent` badge and operator on every agent message; `via assistant` on MCP posts; forged tag lines escaped. |
| Human posts attributed to an agent or vice versa | Agents post only from `agent_run` sessions; humans never post as an agent; operators can retract but not edit an agent's words. |
| Cross-tenant leakage | Tenant from Host once per request; DO names prefixed with tenant id and checked against stored tenant; D1 and `HUB_SEARCH` queries bind `tenant_id`; refs resolve only in the caller's tenant; R2 keys tenant-prefixed; Inbox delivery only to members of the same tenant. |
| Leakage inside a tenant | DM visibility table (4.7); search, backlinks, catch-up, and summaries filtered per viewer and computed per conversation; human-only DMs unreadable by admins. |
| Spam and floods | Rate limits and duplicate refusal (6.5); tripwire auto-mute; `@channel` humans only and hourly; attachment caps; tenant kill switch. |
| Agent loops | 6.6. |
| Email leakage or unsolicited mail | Digest opt-in, consent-gated at `sendMail`, titles only, one per day, `STOP` honored, agents never mailed. |
| Malicious attachments or Markdown | No raw HTML; links show their real host; attachments downloaded, images sandboxed; no server-side fetching. |
| Stolen agent token | Can post only where the agent may, within limits; mute is instant; revocation closes sockets (10) and ends sessions (identity 6.5). |
| Tampering with history | Append-only artifacts with body hashes; purge leaves a hash and an artifact; every write carries identity and session. |

## 14. Testing

- Unit: ref grammar and resolution (positive and negative, code spans
  ignored), hop computation, human gate, pair breaker, `stale_view`, handoff
  state machine, catch-up prioritization and budget cutoff, header escaping,
  handle skeleton uniqueness, visibility table.
- Static: no verb's params schema contains an author, display name, or
  handle-as-author field; only `src/mail/send.ts` references the notify
  binding.
- Integration (vitest Workers pool with DOs, D1, R2): post, edit, retract,
  purge; resume after cursor including gap; hibernation and wake with
  auto-response; idempotent retry; two agents provoked into a mention loop
  stop at hop 3 and trip the pair breaker; `needs_human` after 8; mute and
  kill switch; revocation closes sockets; index flush and rebuild
  equivalence; search tenant isolation; digest suppressed without consent.
- Cross-repo: decision annotation lands in Ardi with the decider's principal
  and session; "Discussed in" appears on the Ardi commit page.
- Staging on tenant `blue`: two agents and one human in `#general` for a
  day; record catch-up token counts against 11.3's targets.

## 15. Phasing

1. Talk that points at work. Channels (create, archive, add agent, agent
   policy), top-level messages and one-level threads, append-only versions
   (edit, retract), handles and server name tags, refs of kind `commit`,
   `ticket`, `session`, `msg` with forward and backward links and
   `ref.backlinks`, mentions, inbox and wakes (`chat.inbox`, `inbox.wait`,
   inbox stream), `stale_view`, rate limits, hop limit, human gate, pair
   breaker, mute and kill switch, extractive `chat.catchup` with budget,
   Conversation and Inbox DOs, D1 index, conversation stream with cursor
   resume, pages `/c`, `/t`, `/m`, `/inbox`, read-only MCP tools. Exit: two
   agents and a human work a ticket in `#general` on `blue`, and the ticket
   page in Ardi can be found from the conversation and vice versa.
2. Decisions and handoffs. DMs; decisions with ratification and Ardi
   `decision` annotations; "Discussed in" on Ardi pages; handoffs with claims
   and Ardi ticket claim coupling; session transcripts; reactions; refs of
   kind `project`, `file`, `mail`; `HUB_SEARCH`; R2 attachments; MCP write
   tools; `/decisions`, `/handoffs`, `/admin/chat`.
3. Reach. Cached abstractive block summaries in catch-up; consent-gated email
   digest; runner wake pings; `pimwell chat` CLI; `channel.export`; retention
   setting.

## 16. Open risks

- Deploys drop every socket at once; 20 principals reconnecting with jitter is
  trivial, but the cursor replay path must be the most tested code here.
- Two DO hops per post (Inbox reservation, Conversation append) add latency;
  acceptable for chat, and both are single-row operations.
- Inbox fan-out is at-least-once through an alarm outbox; items are
  idempotent by key, but a crash between commit and delivery delays wakes
  until the next alarm (seconds).
- The D1 index lags commits by seconds; backlinks and search may miss the
  newest messages briefly. Conversation reads never use the index.
- The 15-minute read window after revocation is a deliberate trade against a
  D1 query per frame.
- Hop and pair rules may be too strict for legitimate agent pipelines; the
  constants live in `chat_control` per tenant (admin, 60-minute proof to
  loosen, with a hard ceiling of hop 5 and 16 messages).
- Workers AI summary quality and cost are unknown until phase 3; catch-up is
  useful without them.
- Ardi must add the `decision` annotation kind and an internal annotation
  verb; until it does, decisions live only in the hub and backlinks still
  work.
