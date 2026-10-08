# Dispatch: requests to capable, available agents

Status: design for owner review (2026-10-08). Nothing here is built.

## Why

People ask for things wherever they are: their chat app's MCP connection, the Assistant, mail, or a page. Agents of
any kind (Claude Code, Codex, anything that speaks MCP and waits on its inbox) do the work. Pimwell sits between
them, so a request never depends on one machine, one vendor's login, or one person being online.

Robustness to vendors is a requirement. Pimwell never relies on a particular agent's subscription login: if a vendor
restricts its subscription to its own tools, those agents keep working through their own clients, and nothing in
Pimwell changes.

## Owner decisions (2026-10-08)

- **No human approval gates.** A request goes straight to dispatch.
- **Agents inherit their creator's permissions.** An agent can take any work its creator could do or see, with
  limits to be decided.
- **No fairness rule.** Some agents will be stars; dispatch should prefer the agents that do best, not spread work
  evenly.
- **Pi and in-app agents are out of scope for now.**
- **The dispatch rules must be easy to change over time,** and the capability thresholds are tunables.

## 1. Requests

There is one entry point, whatever the surface: `request_feature`, plus the same for bugs and errands, or one
`request` verb taking a kind.
- **Filing:** it files a work item with its source (chat app, Assistant, mail, page) and the requester's own words,
  then hands it to dispatch.
- **The caller's answer** comes straight back: the item's ref, its **difficulty estimate** with one line of
  reasoning, and the dispatch outcome. The outcome is one of: assigned to an agent, queued waiting for a capable
  agent, or suggested to be split into smaller pieces.

## 2. Difficulty and capability

- **Difficulty** runs from 0 to 1, estimated when the request arrives. One quick model call (a new "estimate" model
  purpose) reads the request, the project, and recent related work. Rough anchors: general development ≈ 0.6, the
  frontier of what current top models do reliably ≈ 0.7.
- **Capability** is declared per agent and model by its owner, for example "Claude Code on <model>: 0.7". It's
  stored with the model name, so swapping models changes it.
- **The gate:** dispatch assigns only when capability ≥ difficulty + margin. The margin and any per-kind offsets
  are settings.
- **Calibration:** each finished job records its outcome: approved first time, reworked, reassigned, abandoned. This
  later adjusts both the difficulty estimator and agents' effective capability. Version one records outcomes and
  shows them; adjustment comes after.

## 3. Presence

Each agent has a state, derived rather than declared:
- **available:** waiting on its inbox (`inbox_wait`), or active within the last few minutes, and below its job limit;
- **busy:** at its claimed-job limit, or has said it's busy (a new `agent_status` call);
- **offline:** quiet past the presence window.

Busy and offline agents get no new work. Several agents are expected to be connected most of the time.

## 4. Rules as data

Dispatch rules are an ordered list stored in the database, versioned, and editable by admins over MCP and on a page.
Each rule is a condition and an effect: **exclude** a candidate, **require**, or **prefer** with a weight. Every
assignment records the rule version and which rules decided it, so "why did this go to that agent?" is a lookup.

Starting rules, in order:
1. **Permitted:** the agent's creator could do this work; agents inherit their creator's permissions, with limits
   to be decided.
2. **Willing:** the agent takes this project and kind of work, as its owner configured.
3. **Capable:** capability ≥ difficulty + margin.
4. **Available:** not busy or offline.
5. **Stars:** prefer agents with the best recent outcomes on similar work. This deliberately replaces fairness.
6. **Continuity:** prefer an agent already working on related items (same quest, same files).
7. **Cost:** among equals, prefer the cheaper agent (lower capability that still clears the gate, or a
   subscription-backed one).

If no agent passes, the item waits in the queue. Each time an agent becomes available, dispatch re-runs for the
queue, so nothing needs a person to unstick it.

## 5. Jobs and resilience

- **Offer:** a job reaches the chosen agent's inbox carrying everything needed, so the agent never has to go
  looking: the item and the requester's words, links to related work, recent commits and errors, the repository and
  branch to use, the difficulty, and what "done" means.
- **Claim:** the agent claims it with the existing one-hour lease, renewed as it works.
- **Recovery:** if the agent goes offline or its lease lapses, the job goes back to dispatch with its progress
  intact (branch, comments, review). The requester sees "reassigned", never silence.
- **One agent missing is routine.** No job is bound to one machine.

## 6. Talking both ways

- **The job's thread:** each job has a conversation thread, in a project channel or a direct thread between
  requester and agent. The agent posts progress and questions there; the requester answers from their chat app
  (MCP) or Pimwell. A reply wakes the agent through its inbox, as mentions do today.
- **Direct messages:** people can message an agent directly; an agent answers in the same thread.
- **One skill for all agents** ("taking-jobs") tells any agent the routine:
  1. wait on the inbox;
  2. claim;
  3. work on a branch;
  4. ask in the thread when stuck;
  5. open a review;
  6. report usage;
  7. finish.

## 7. What "done" means (proposed)

The agent opens a review and reports done. Merging stays as today: the review gets merged once Ardi has its merge
verb. The reviewer agent can give a second opinion first. Open for the owner to change.

## Open questions

1. **Limits on inherited permissions.** Candidates: agents can't manage people or keys (already true), can't send
   mail outside the 30-day rule (already true), and get a spend cap per day.
2. **The first difficulty anchors and margin:** start with margin 0.05 and these anchors?
   - snag 0.4, errand 0.3, wish 0.6, quest 0.8;
   - the model adjusts from those.
3. **Splitting.** Should Pimwell offer to split a too-hard request into smaller items itself, or only suggest it?
4. **Done:** confirm "an open review" as done.

## Build order once approved

1. **Data:** requests and difficulty, agent capability and presence, a dispatch log, rules as data with the starting
   rules.
2. **Dispatch:** with the queue re-run on presence changes, and lease lapse leading to reassignment.
3. **Job threads and the taking-jobs skill:** then end-to-end tests with two simulated agents, including one going
   offline mid-job.
4. **Outcomes and the stars rule.**
