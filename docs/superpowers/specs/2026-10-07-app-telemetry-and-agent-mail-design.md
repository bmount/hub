# App telemetry, health checks, and agent mail: design

Status: draft for owner approval (2026-10-07). Nothing here is built yet. Four of its parts touch other repositories
or security properties:
- the AgentFeed and PriceBench configuration;
- who may email an agent;
- outbound mail;
- the pimwell.com DNS for sending.

## Why

Pimwell is a hub. Agents stay connected, executives work over MCP all day, and the apps we run should report into it.
The north star is to understand what happened and why, and to fuse monitoring with source control. That needs each
app's errors, health and deploys in Pimwell next to the work and the code. Agents also need ordinary email, inbound
and outbound, to act as a bridge for people who work by mail.

## Part A: getting app data in

AgentFeed and PriceBench run in the same Cloudflare account as Pimwell. That lets every path below avoid the public
internet.

### A1. Logs and exceptions: a Tail Worker

- Pimwell ships a second, small Worker, `pimwell-tail`, from this repository. Its `tail()` handler receives what
  Cloudflare reports after each invocation of a producer app: outcome, `console` lines, uncaught exceptions, the
  script version, and the request.
- An app opts in with one line of its own configuration: `"tail_consumers": [{ "service": "pimwell-tail" }]`. No
  application code changes.
- `pimwell-tail` passes events to the hub over a service binding, to an RPC entrypoint the hub exports. It is not an
  HTTP route, so there is no public ingest URL to attack.

Security properties:
1. **Source identity comes from Cloudflare.** The event's `scriptName` is set by the platform, not by the app's code.
   An organization admin maps a script name to a project (`app_source`: tenant, project, script name, enabled).
   Events from unmapped scripts are dropped and counted, never stored.
2. **Redaction before storage.** Tail events carry full URLs and headers. The tail worker keeps:
   - method, path, and query key names (never values);
   - status, outcome, the Ray ID, colo and script version.

   It drops every header except the Ray ID. In log lines and exception messages, it masks anything shaped like a
   credential (`pmw_`, `pms_`, `Bearer …`, `sk-…`, JWTs) or an email address before they leave the tail worker.
3. **Bounded.** Per-source caps: events per minute and line length. Raw info logs are not kept. Stored are errors,
   warnings and exceptions (grouped by fingerprint), plus a 1% sample of successful requests for latency. Raw events
   are kept for 30 days; groups for as long as the project exists.
4. **Data, not instructions.** App output reaches people and models only through the existing data note, like mail
   and messages.
5. **No loops.** The hub never lists `pimwell-tail` as its own tail consumer for the ingest entrypoint. Pimwell's own
   telemetry uses the logs it already writes (docs/ops/logging.md).

What people see:
- **A Traces area per project:** error groups with counts, first and last seen, the script version and deploy that
  introduced each one, and "File a snag" with the group attached.
- **#<project>-ops posts:** a new error group, or one that comes back after a quiet period, gets a message in the
  project's ops channel. Agents subscribed there can pick it up at once.
- **MCP:** `trace_list` and `trace_read`, read-only.

### A2. Health checks: an RPC entrypoint, not a URL

- An app exports a small `WorkerEntrypoint` class, `PimwellProbe`, with `health()` and `version()` methods. These are
  RPC methods, callable only through a service binding. The internet cannot reach them, so no secret is needed.
- The hub lists each app under `services` (for example `{ "binding": "APP_AGENTFEED", "service": "agentfeed",
  "entrypoint": "PimwellProbe" }`).
- A hub cron runs every five minutes and calls `health()` with a 3-second timeout. It records up, degraded or down
  with timing, and posts a change of state to #<project>-ops.
- `health()` returns only booleans and timings, for example `{ ok, checks: { db: true, upstream: false }, ms }`, and
  never error text. That keeps it safe even if a future binding were misconfigured.

### A3. Deploys: free from the tail stream

Each tail event carries the script version id. When a new version id appears for a mapped script, Pimwell records a
deploy. If the app deploys with `wrangler deploy --tag <git sha> --message "<subject>"`, the deploy links to the
commit, and through it to the work items and reviews that mention it. `deploy_record` stays available for anything
deployed some other way.

### A4. Pimwell itself

Pimwell builds Pimwell, so the hub's own error lines feed the mcc/pimwell project's Traces the same way, through a
direct internal call rather than a tail loop.

## Part B: agent mail

### B1. Addresses (approved 2026-10-07)

- **Address format:** agents get `<org>.<agent>@pimwell.com`, one name space with projects, first come, first served.
- **No people at pimwell.com:** no person's account, invite or sign-in link may use any `@pimwell.com` address.
- **No mail sign-in for agents:** agents never sign in by email.
- **Migration:** existing agents move from `<agent>@<org>.pimwell.com` in one migration.

### B2. Inbound

- **Delivery:** mail to an agent's address is stored like project mail, with the agent as its recipient. It wakes
  the agent through the same inbox it already waits on (`inbox_wait`).
- **Who may write:** members of the organization, vetted as today (a receipt proves the sender). Proposal: an agent's
  operator or an admin can add outside senders to that agent's "accepts mail from" list. Mail from anyone else is
  held for the operator, never shown to the agent.

### B3. Outbound: Cloudflare Email Service

Cloudflare Email Service (public beta) sends from a Worker binding to arbitrary recipients on the Workers Paid plan.
It needs SPF, DKIM and DMARC records for pimwell.com in Cloudflare DNS. The send gate keeps the golden rule:
1. **Only to someone who wrote first.** The recipient must have written to that agent's or project's address within
   the last 30 days, recorded in the existing consent ledger.
2. **Limits:**
   - each agent has a daily cap (default 50);
   - each organization has a kill switch, off by default until an admin turns sending on.
3. **Everything on the record:** every message sent is stored in full, with the agent, the run that sent it, and the
   message it answers. People see it on the thread; it is in the event log.
4. **No attachments at first.** Text and simple HTML only.
5. **New verbs:** `mail_reply` (answer a received message) and `mail_send` (a new message to someone who wrote first),
   for agents and people alike, in the same verb table and over MCP.

Open technical question: the Workers binding documents `to`, `from`, `subject`, `text` and `html`. For a reply to
thread in the recipient's mail client, it also needs `In-Reply-To` and `References` headers. If the binding can't set
them, replies go through the Email Service REST API from the Worker, with a scoped API token kept as a secret.

## Decisions needed from the owner

1. **Plan:** confirm the account is on Workers Paid. Tail Workers and sending to arbitrary recipients both need it.
2. **App opt-in:** may I add the `tail_consumers` line and the `PimwellProbe` entrypoint to AgentFeed and PriceBench?
   These would be small, separate commits in those repositories, deploying the way each deploys.
3. **Outside senders:** may operators and admins let specific outside addresses email an agent?
4. **Golden-rule window:** 30 days since the person last wrote. A different number?
5. **Sending DNS:** add the SPF, DKIM and DMARC records for sending from pimwell.com. They coexist with today's
   Email Routing MX records. I can apply them with the deploy token once approved, or you add them in the dashboard.

## Order of work once approved

1. B1 (approved): addresses, migration, inbound agent mail with wake.
2. A1 and A3: tail worker, redaction, mapping, Traces, deploys, ops-channel posts.
3. A2: health probes.
4. B3: outbound mail behind the gate, after the DNS records.
