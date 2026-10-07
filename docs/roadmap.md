# Roadmap

Where Pimwell is going, in the order we intend to build it. Each milestone ends with an exit test written
against the owner's real projects, not against fixtures. `docs/direction.md` says why; this page says what
and when. Update it as items ship: change the status, link the spec or plan, and record what we learned.

Status values: **done**, **now** (in progress or next up), **next**, **later**.

## The end state

Pimwell runs an information-sector company end to end. The team is small, cohesive, and flat, and many
of its workers are AI helpers. Legal sits one step removed: contracts and employment live outside
Pimwell and govern its use.

One system holds the following, joined by shared ids:
- source;
- every deploy;
- what the running software does, how fast it does it, and who it affects;
- what users spend and generate;
- the work queue, and who (human or helper) is doing what;
- moderation of what users put into the company's products;
- the conversations where decisions are made.

Anyone can ask what happened and why and get an answer with evidence. Anyone can change behavior, from
Pimwell itself or from their own ChatGPT or Claude session, and the change is as traceable as the
problem.

## The model, corrected (2026-10-06)

- **Tenant means organization.** One tenant per company or organization, at `<org>.pimwell.com`.
  Never a tenant per repo or project: two groups each wanting a `config` project would collide on the
  subdomain.
- **Projects live inside the organization.** A project is a repository, a tracker, a service, or a
  product. Its address is a path, such as `<org>.pimwell.com/<project>.git`. Namespaces can group projects
  when an organization grows, for example `<org>.pimwell.com/<namespace>/<project>`.
- **Teams are light groups inside an organization, not walls.** The organization is flat. Access is
  per project where it needs to be, and organization-wide by default for the core team.
- **Consequence:** project-level access becomes necessary. The identity spec's v1 non-goal ("roles live
  at tenant level") is reversed in milestone 1. Without it, a colleague given "an initial project"
  would see every project in the organization.

## Milestone 0: foundation (done)

| Item | Status | Where |
| --- | --- | --- |
| Hub on Workers with D1, KV, R2, and Durable Objects; tenant hosts; deploy as `pimwell-001` | done | `docs/ops/cloudflare.md` |
| Identity: invites, magic links both ways, sessions, fresh proof, root | done | identity spec, plans phase 1 to 3 |
| Agents: named helpers with a sponsoring person, run sessions, API tokens | done | identity phase 3 |
| Sign in with Google behind root-managed rules and grants | done | identity spec amendment, `docs/ops/google-signin.md` |
| MCP: OAuth 2.1 at the apex, per-tenant `/mcp`, read-only tools | done | MCP spec, plan |
| Git hosting via Ardi on tenant hosts, hub-issued git credentials | done | Ardi-hub integration spec |
| Messaging: channels, threads, links, agent wakeups with loop limits, catch-up | done | messaging spec, plan |
| Landing page, privacy policy, terms | done | `site/` |
| First real projects imported into the organization tenant | done | two repos, full history |

## Milestone 1: an organization you can see into (now)

Goal: open the organization and understand each project's code and history without leaving Pimwell.

| Item | Status | Notes |
| --- | --- | --- |
| Project-level access: per-project grants (admin, member, reader) beside organization membership | now | amends identity spec; sign-in grants can target a project |
| Fold the interim Commons tenant into the organization as a project | next | needs project-level access first |
| Organization home: projects, recent activity, people and helpers | now | today a signed-in page is nearly empty |
| Project page: branches, commits, files, blame, diffs | now | reads Ardi through the hub; builds on Ardi `/internal/resolve` |
| Create a repo project from the hub; the hub creates the Ardi repo | next | removes the manual `repo.create` step |
| Git credentials and clone instructions on the project page | next | `session.git` exists; this is the UX |
| Upstream sync: keep imported repos current with their GitHub upstreams, mirroring in or out | now | the imports are snapshots until this exists |
| Large pushes: one push of any reasonable size | now | owned by the Ardi session; chunked pushes work meanwhile |
| Landing copy matches the model: an organization's own address, projects inside it | done | 2026-10-06 |

Exit test: the owner opens the organization, picks the larger imported project, reads its last 20
commits, sees that main matches GitHub, and finds who changed a given file and when.

## Administration and providers (spec: `docs/superpowers/specs/2026-10-07-admin-design.md`)

| Item | Status | Notes |
| --- | --- | --- |
| Model providers and keys: encrypted storage, verify, rotation, purpose routes, "Models and keys" admin | done | P1, 2026-10-07: OpenAI key active; /admin/models |
| MCP for everything: hub endpoint, admin, hub and secrets scopes, resource sets, closed-list test | next | P2 |
| Plans and approval classes, approval pages | next | P3 |
| Organizations and project-level access over every surface | next | P4 |
| Project move and copy between organizations | next | P5; needs an Ardi transfer verb |
| Sandbox organizations | next | P6 |

Exit test: in ordinary chat, the owner creates an organization and moves a project into it (spec section 13).

## Milestone 2: work, assigned and accounted for

Goal: every piece of work has an owner, a reason, and a trail.

| Item | Status | Notes |
| --- | --- | --- |
| Tasks inside projects: open, claim with a lease, done, archived | next | messaging already links tickets |
| Assignment to people or helpers, with workload visible per assignee | next | |
| Links among tasks, commits, branches, conversations, and deploys, by shared id | next | "why was this created" becomes a lookup |
| Commit trailers or push metadata that bind a commit to a task and a helper session | next | Ardi records the identity and session already |
| Status from records: "what happened since Monday" on a project or task, built from commits, deploys, and tasks | later | the honest status report, before any model writes prose |
| Task, assignment, and status verbs over MCP | next | parity rule: anything on a page is a verb |

Exit test: a task about an imported project is assigned to a helper. The helper's commit lands linked
to the task, and the task page shows the commit, the session, and the person the helper answers to.

## Milestone 3: deploys as first-class records

Goal: know which commit is running where, and since when.

| Item | Status | Notes |
| --- | --- | --- |
| Deploy record: project, environment, commit, actor, time, outcome | next | written by a deploy hook or CI, or by Pimwell's own deploys |
| Cloudflare Workers integration: read versions and deployments; map version to commit | next | most of the organization's projects run on Workers |
| Other targets via a generic deploy webhook | later | |
| Rollback recorded as a deploy of an earlier commit, one click from the deploy record | later | |
| "What came after this commit": deploys, errors, follow-up commits, reverts on the commit page | next | the landing page's opening question |

Exit test: a commit page shows "deployed to production at 14:02 by a named helper, still live".

## Milestone 4: what the code did in production

Goal: from a logged error to the line of code, the commit, and the reason it was written.

| Item | Status | Notes |
| --- | --- | --- |
| Error and log ingestion tagged with the deploy id: Workers Tail or Logpush, plus an OpenTelemetry endpoint | next | |
| Stack frame resolved to path and line at the deployed commit, with source maps kept per build | next | |
| Click from an error to the line, then to blame, the commit, the task, and the helper session | next | the core fusion |
| Timing: duration per route and per function, by deploy | later | "how long it takes to run" |
| Reach: distinct users affected by an error or a change | later | "how many users noticed"; privacy-preserving counts |
| Alerts into channels; helpers can subscribe and wake on them | next | messaging wakeups exist |
| Pimwell monitors Pimwell | next | dogfood from day one |

Exit test: an error in a deployed imported project opens to the exact line at the deployed commit, with
who wrote it, why, and how many users hit it.

## Milestone 4b: traces, threads, and backfilled history

Goal: from any trace to its cause, and history recovered from what people already wrote (`docs/direction.md`).

| Item | Status | Notes |
| --- | --- | --- |
| Trace ingestion (OpenTelemetry) with deploy id; spans resolved to source lines at the deployed commit | next | builds on milestone 4's error ingestion |
| Causal links between traces and the requests or jobs that started them; "what led to this" view | later | |
| Apps hosted in Pimwell's own world emit traces with ids Pimwell already knows | next | the first apps are the organization's own |
| Thread to structure: paste or forward an email thread; models propose decisions, tasks, owners, dates, each cited to its sentence; a person confirms | next | uses the `deep` purpose; mailboxes spec for forwarding |
| History backfill from email, old trackers, chat exports, and repos; inferred items marked until confirmed | later | |

Exit test: a slow request in an imported project's app opens to the span, the line, the commit that
introduced it, and the earlier request that triggered it. A forwarded thread about that project
becomes three confirmed tasks with owners and their source sentences.

## Milestone 5: what it earns and costs

Goal: tie code and features to money and usage.

| Item | Status | Notes |
| --- | --- | --- |
| Product events from the organization's apps, minimal and privacy-preserving | later | |
| Revenue events, for example from Stripe webhooks, attributed to features and releases | later | "what those users spend" |
| Running cost per project: Cloudflare usage, model spend per helper and per task | later | |
| Feature ledger: cost to build, cost to run, users reached, revenue, on one page | later | |

Exit test: one page answers whether a recent feature of a project is paying for itself.

## Milestone 6: helpers that change the software

Goal: helpers fix and build, safely and accountably.

| Item | Status | Notes |
| --- | --- | --- |
| Pi coding agent as a hosted helper in a sandbox, working on Pimwell repos | next | `docs/direction.md` |
| Model subscriptions as well as API keys, per sponsoring person or team | next | |
| Change requests: a branch, a diff, review, approve, merge, all in Pimwell | next | needed before helpers write to main |
| CI runs on push, with results linked to the commit | later | |
| Deploy policy per project: what a helper may ship alone | later | small, low-risk fixes only, recorded and revertible |
| Typed decision seam: TypeSafe Jev now, Cloudflare Clef later; first use is error triage | next | every decision logged with its inputs and probabilities |
| Change Pimwell-hosted behavior from your own ChatGPT or Claude session over MCP, with write tools | next | today's MCP is read-only |

Exit test: an error in an imported project becomes a task. Triage judges it small, Pi opens a change
with a fix, a person approves it, and the deploy and the error's disappearance are linked to all of it.

## Milestone 7: situations in, the truth out

Goal: the core value proposition in `docs/direction.md`.

| Item | Status | Notes |
| --- | --- | --- |
| Situation intake: a person describes a problem in chat, email, or their own assistant | later | |
| Diagnosis with evidence: logs, code, deploys, and tasks, from the strongest available model | later | every claim cites its records |
| Assignment proposal across people and helpers | later | |
| Status from records, never "everything is fine" | later | builds on milestone 2 |
| First-principles cost and complexity estimates, plainly stated | later | protects engineers from impossible asks |
| Reports and estimates stored as records, compared later with what happened | later | |

Exit test: an executive asks why signups dropped on a project last week and gets a cause, evidence,
owners, and an honest estimate, without a meeting.

## Milestone 8: moderation, safety, and trust

Goal: run user-facing products responsibly, with helpers doing most of the work.

| Item | Status | Notes |
| --- | --- | --- |
| Moderation queues for user content in the organization's products, with typed decisions and human review | later | |
| Helper guardrails: per-project scopes, spend limits, kill switch, loop limits | next | the kill switch and loop limits exist in messaging |
| Secrets per project, with clear ownership; nothing shared across apps by accident | next | `docs/ops/google-signin.md` has the naming rule |
| Permissions review: who and what can touch each project, and why | later | |
| Backups and one-file project export, readable with ordinary tools | later | "yours" on the landing page |
| Audit export | later | |

## Milestone 9: running the company

Goal: the rest of what a small, flat information-sector company needs, in one place.

| Item | Status | Notes |
| --- | --- | --- |
| Mailboxes for people and helpers | next | spec written: mailboxes design |
| Real-time pages over WebSockets | next | messaging phase 2 |
| People and helper directory, onboarding by invite or sign-in rule, offboarding | later | |
| Knowledge: decisions, runbooks, and documents linked to the work | later | |
| On-call and incident records, tied to alerts and deploys | later | |
| Budget and spend across projects, people, and helpers | later | |
| CLI with full parity to MCP and the pages | later | |

## Cross-cutting rules

- **Shared ids, never synced copies.** Every new record carries the ids it joins on: org, project,
  commit, deploy, task, session, actor.
- **Every write has an actor.** A person or a helper, and a helper always has a sponsoring person.
- **Parity.** Every page action is a verb, available over MCP and later the CLI.
- **Real projects are the test.** Each milestone's exit test runs against the owner's real projects.
- **Implementation details never headline.** Marketing and docs lead with outcomes (see
  `docs/direction.md`, Messaging).

## Suggested next three iterations

1. Project-level access, and fold Commons into the organization as a project.
2. Organization home and project page (commits, files, blame), plus upstream sync for the imported repos.
3. Deploy records with the Cloudflare Workers integration, then error ingestion for one imported project.
