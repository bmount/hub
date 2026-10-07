# Overnight, unattended: plan for 2026-10-07 to 2026-10-08

Owner directive (2026-10-07, evening): examine the roadmap and run unattended overnight. Continuous outer goal,
starting now: **an inviting but deep-feeling, deep-acting UI, with every feature reachable through ordinary
navigation.** Performance is first-class at all times. Pimwell's own development becomes the first Pimwell
project. Agents get skills, reachable over MCP. MCP surfaces project history and outstanding work. Copy keeps
reminding people that old constraints no longer apply.

Spec authority: `docs/direction.md`, `docs/roadmap.md`, the identity, MCP, messaging, mailboxes and admin specs.
Rulings made during the night go in the ledger (below), each with why and what it costs if wrong.

## Guardrails for an unattended night

- **Isolation.** Work only in this worktree, branch `identity-phase1`. Commit after every task. Push to the
  branch, and fast-forward `main` only when the full suite is green or failing only on the known flaky set
  (task 1 shrinks that set).
- **Deploys.** Deploy after each task that passes its checks. Never deploy over a failing check.
- **Never.** Delete production data, change Ardi or its Workers, touch DNS, rotate credentials, send mail to
  anyone outside the hub's consent rules, or change sign-in policy.
- **Data-shaped work.** Anything that writes production rows other than through the app's own verbs (backfill,
  seeding) runs through a script kept in the job's scratch directory and listed in the morning report.
- **Performance budget.** Checked on every UI task:
  - server time under 150 ms at the 95th percentile for any page on warm D1;
  - no page over 6 D1 queries without a ruling;
  - HTML under 60 KB before compression, except the landing page;
  - no client framework.

  Any regression is fixed before moving on.
- **Stop conditions.** Stop and leave a note at the top of the ledger when:
  - a task breaks a guardrail;
  - the suite fails twice in a row on something outside the known flaky set;
  - a ruling would change a spec's security property.
- **Morning report.** `docs/superpowers/2026-10-08-overnight-report.md` lists what shipped (with commits), what was
  ruled, what was skipped and why, and what needs the owner.

Ledger: `docs/superpowers/2026-10-07-overnight-ledger.md`, appended after every task.

## Names: fun, but always with the plain word

Work items get their own vocabulary. Every display shows the plain word next to the name the first time it
appears on a page, for example "Snag (bug)", and the MCP tools accept both forms.

| Pimwell name | Plain word | Meaning |
| --- | --- | --- |
| Wish | feature request | Something someone wants to exist |
| Snag | bug | Something that does not work as it should |
| Errand | task | A concrete piece of work with an owner |
| Quest | epic | A larger goal made of errands, snags and wishes |
| Call | decision | Something decided, with who decided it and why |
| Spark | idea | Unshaped and worth keeping; can grow into a wish or a quest |
| The Docket | backlog, board | Everything open in a project, in one list |

The names are data in one module, so the owner can rename them in the morning without code changes elsewhere.

## Tasks, in order

Each task lists its exit check. Tasks build on each other; if one stops, later ones that do not depend on it
continue.

### 0. Mailbox names never collide (small)

- Reserve as organization names every local part the hub or the internet uses for mail: `privacy`, `legal`,
  `postmaster`, `abuse`, `hostmaster`, `webmaster`, `security`, `noreply`, `no-reply`, `bounce`, `bounces`,
  `dmarc`, `notify`, `support`, `help`, `info`, `hello`, plus the existing labels.
- Check existing production organizations against the list (none collide today: blue, commons, mcc, agentfeed,
  pricebench).
- Exit: `tenant.create` refuses each reserved name, and a test sends mail to `privacy@` and gets the forwarding
  rule, never an organization.

### 1. A test suite that can be trusted overnight

The full suite fails one random test per run with "Isolated storage failed (.sqlite-shm)". Find the cause:
an unawaited D1 or Durable Object promise outliving its test, `waitUntil` work, or a pool setting. Fix it.
- Exit: three consecutive full runs green.

### 2. Work items: wishes, snags, errands, quests, calls, sparks (roadmap M2 core)

- Table `work_item`:
  - id, tenant and project;
  - kind, title, body;
  - state: open, doing, done or dropped;
  - owner (a person or helper), created by, the source it came from (mail id, message, event, or this owner's
    words), and parent (for quests);
  - timestamps.
- Table `work_link` joins an item to a commit, mail, message, event, or another item.
- Verbs, all over MCP:
  - `work.create`, `work.update`, `work.list` (the Docket, with filters), `work.read`;
  - `work.claim`, a lease of one hour, renewable;
  - `work.link`.
- Pages, on the organization host:
  - `/<project>/docket` for the Docket;
  - `/<project>/w/<id>` for one item, with its links and history.
- Exit: create, claim, link and close from a page, the API and MCP; every change recorded as an event; tests.

### 3. Pimwell is the first Pimwell project

- Create project `pimwell` in the `mcc` organization, of kind tracker, through the verb, as root or the owner.
- Backfill the owner's directives from this development history as calls, wishes, quests and errands:
  - Read the session transcript and the docs, then write each item through `work.create`.
  - Each item's source is the owner's own words, quoted briefly, and their date.
  - Each one shipped is marked done and linked to the commit that delivered it.
  - Everything still open stays open, with its roadmap milestone.
- Exit: the Pimwell project's Docket shows the history of Pimwell from its first spec to tonight, and every
  open roadmap item exists as an open wish or quest.

### 4. Navigation and the deep UI, round 1 (outer goal; continuous)

- One shell on every authenticated page:
  - **Header:** the organization, a search field (to be wired up later), and the person.
  - **Primary navigation:** Home, Projects, Docket, Mail, Conversations, People and helpers.
  - **Footer:** Admin for those allowed, plus Privacy and Terms.

  It works with the keyboard and on phones, and needs no JavaScript to navigate.
- Organization home:
  - what changed since your last visit across projects, people and helpers;
  - open work by kind;
  - recent mail.

  Each part links one level deeper.
- Project page: one timeline joining events, work items, mail and (when available) commits, with filters. This is
  the first concrete step toward "what happened and why".
- Empty states and helper text carry the "old constraints are gone" reminders, short and specific. For example:
  - "No triage meeting needed. Forward the thread and Pimwell sorts it."
  - "You don't need to know which team owns this. Send it to the project."
- Exit: every existing feature is reachable from the shell within three clicks; the budget is met on every page;
  screenshots at desktop and phone width reviewed.

### 5. MCP: history, the Docket, skills, and capabilities

- Tools:
  - `project_history`: the joined timeline from task 4, paged;
  - `docket`: open work, filtered by kind, owner and state;
  - `capabilities`: what this connection can do, and why not (admin spec 4.4).
- Skills: short guides for agents in `skills/`, for example:
  - how to file a snag well;
  - how to read mail as evidence;
  - how to claim and finish an errand;
  - how to report status from the record;
  - how to work on the Pimwell project itself.

  They are served as MCP resources (`pimwell://skills/<name>`) and through a `skills` tool for clients without
  resource support, and also at `/skills` on the site.
- Exit: from an MCP client, an agent can learn the system from `skills`, see the Pimwell project's history and
  Docket, and file a snag. A test drives each through the MCP transport.

### 6. The MCP sandbox, and stressing auth (admin spec P2 and P6, first slice)

- **Sandbox organizations** (`sbx-word-word`), created by any writer. They cannot email out, deploy, or reach
  outside the hub. They expire to archive after 30 days.
- **The MCP Playground** (`/playground` on a sandbox host): lists the tools for a chosen scope set, shows each
  schema, runs a call and shows the exact JSON-RPC request and response, with timing. It uses a real OAuth grant,
  minted for the playground with the scopes chosen, so it exercises the real auth path.
- **Auth stress suite**, automated and run in CI and on demand against a sandbox. It covers:
  - wrong resource and cross-tenant tokens;
  - scope escalation;
  - expired and revoked grants;
  - refresh replay;
  - downgraded roles mid-session;
  - archived and deleted organizations;
  - per-grant rate limits;
  - and that no tool result ever contains a secret.
- Exit: the playground runs every read tool and the work tools against a sandbox; the stress suite passes; any
  hole found is fixed before anything else that night.

### 7. Performance watch (continuous)

- `Server-Timing` headers on every page and API call, with D1 time and query count.
- A perf smoke script hits the key pages and MCP tools against production after each deploy, and records p50 and
  p95 in the ledger. Any page over budget is fixed before the next task.

### 8. If time remains

In order:
1. Thread to structure for mail: propose wishes, snags and calls from a forwarded thread, citing sentences; a
   person confirms. This uses the `deep` purpose.
2. Project-level access (roadmap M1).
3. Admin spec P3 plans and approval pages.

## Not tonight

Ardi changes, including large pushes and repo delete (owner: wait for its fix); deleting the archived per-repo
organizations (an owner click); Pi; deploy records (needs per-project deploy access).
