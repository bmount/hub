# Direction

This is what Pimwell is for, and the architectural commitments that follow from it. Specs and plans
argue from this page. When a design choice is unclear, pick the option that serves the north star.

Recorded 2026-10-06 from the owner's direction.

## North star

1. **We will make it unprecedentedly easy to understand what happened and why.**
2. **We will make it unprecedentedly easy to modify behavior to meet your users' needs.**

The first is about provenance: every effect can be traced to its cause. The second is about
change: once you understand, acting on it is a short step, often one a helper can take for you.
This is also the core of the product's messaging. Public copy says it in plain words, for example
"You can always see what happened and why, and change what happens next to fit the people you serve."

## The integration tax

Monitoring, source control, and project management have always lived in separate tools. Joining
them, so that an error links to the code that raised it, the change that introduced that code, and
the request that prompted the change, has been possible in principle and almost never done in
practice. Each join is a custom integration with its own identifiers, its own sync jobs, and its own
drift, and nobody could afford to keep all of them alive. Call that cost the **integration tax**.

Pimwell exists to stop paying it. One system holds the code, the work, the people and helpers, and
what the running software did, under one set of identities. The joins are then ordinary
lookups, not integrations.

When we design a feature, ask: which integration tax does this remove, and which identifiers does it
need to carry so the joins stay free?

## Fusion of live monitoring and source control

The goal is to go from what happened in production to why it happened, without a search.

- **From a logged error to a line of code.** Every deployed build carries the commit it was built
  from, and keeps the source maps or equivalent needed to resolve a stack frame to a path and line at
  that commit. Clicking a frame in an error opens that line, at that commit, in the hub.
- **From a line to who wrote it and why.** Each line resolves, through the commit that last
  changed it, to the author. The author is a person or a named helper, and every helper answers to a named
  person. For a helper, the commit links to the session that produced it and to the task,
  error, conversation, or commit it was responding to.
- **Forward as well as backward.** Source control answers "what came before this commit". Pimwell must
  also answer "what came after": where it was deployed and when, which errors it raised or fixed,
  what was built on top of it, and whether it was reverted.

Architectural consequences, to honor from the first version of each subsystem:

- Identifiers are shared, not synced. Commits, deploys, errors, tasks, sessions, and messages refer
  to each other by stable ids owned by the hub. Nothing is copied into a second system that could drift.
- Every write records an actor. The actor is a person or a helper, and a helper always has a
  sponsoring person. This is already true for identity, sessions, and source control. Monitoring
  and deploys must follow.
- Every helper session is recorded from start to finish and linked to its inputs and its outputs.
- Deploys are first-class records: which commit, which environment, who or what triggered it.
- Errors and logs from deployed code are ingested into the hub with their deploy id. That id makes
  the jump from an error to its commit a lookup.

## Helpers that change the software

### The Pi coding agent, early

We integrate the open-source Pi coding agent (Mario Zechner's pi-mono, published as
`@mariozechner/pi-coding-agent`, MIT licensed) early, as the first helper that edits code. Its first
jobs are bug fixes and simple feature requests.

- It works as a named helper with its own identity and a sponsoring person, like any other helper.
- It starts from a linked context: an error with its resolved line and commit, or a task. It does
  not start from a free-form prompt with no provenance.
- Its output is a commit on a branch with its session attached. A person reviews it. It does not
  deploy to production on its own.
- Pi's small toolset (read, write, edit, bash, grep, find, ls) and its multi-provider model layer
  keep this cheap to host and easy to sandbox.

This is the loop the north star promises: something goes wrong, you can see exactly why, and a
helper proposes the change.

### The self-modifying hub

The hub will eventually change itself. That raises the bar on the commitments above. Every change it
makes to itself must be as traceable as a person's, and the credential it runs with must be
narrower than the developer credential. See `docs/ops/cloudflare.md`.

## Decision models in the reference implementation

Many points in Pimwell are decisions, not text generation. Examples: is this error urgent, which
project owns it, should a helper attempt a fix or hand it to a person, does this inbound mail
satisfy the reply-only rule, is this change risky enough to need a second reviewer. Decision models
answer exactly these questions. You give them a state and a schema of typed questions. They return
typed answers with probabilities and cannot answer outside the schema.

- **TypeSafe support from the beginning.** TypeSafe AI's Jev decision model ships a TypeScript SDK,
  `@typesafe-ai/sdk`, in which questions are defined in code. Return types are therefore checked at
  compile time. The hub's reference implementation includes a decision seam built on that shape
  from the start.
- **Cloudflare Clef later.** Cloudflare's open-weight decision models, `@cf/cloudflare/clef` and
  `@cf/cloudflare/clef-flash`, run on Workers AI. They accept the same kind of state plus typed
  questions (choice, score, and yes/no), so they slot in behind the same seam.
- **Built in so we think to use them.** The decision seam lives in the reference implementation,
  with at least one real use, for example error triage. A new branch on fuzzy input should be
  written as a typed decision, not as an `if` on a heuristic or a prompt that returns prose.
  Every decision is logged with its inputs, answers, and probabilities, and linked to whatever it
  caused, so decisions are as explainable as code. That keeps decisions inside the north star.

Not built yet: the decision seam, the Pi helper, deploy records, and error ingestion. This page is
the commitment; specs for each will reference it.
