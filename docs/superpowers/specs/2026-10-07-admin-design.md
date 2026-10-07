# Administration, MCP everywhere, and model providers: design

Date: 2026-10-07
Status: design, owner-directed. Implementation is phased in section 12.
Builds on: identity spec (and its Google amendment), MCP OAuth spec, Ardi-hub integration spec,
`docs/direction.md`, `docs/roadmap.md`.

## 1. Outcome

The owner opens an ordinary Claude or ChatGPT chat with Pimwell connected and says:

> Create a new organization called Northwind, then move the AgentFeed project from our current
> organization into it.

The assistant does the following, and nothing here needs a terminal or a Pimwell page except one
approval click:
1. Calls `org_create` and gets back a plan: "Create organization `northwind` (Northwind); you become
   its admin."
2. Shows the plan in chat. The owner approves it, either in chat or by following one link (section 6).
3. Calls `project_move` for AgentFeed. The plan lists every effect: the repository copied with all
   refs, the project re-homed, the old address answering "moved", access in the new organization
   being its members, and links and history following the project.
4. After approval, applies the move. It reports the new clone URL and that the hub's copy of main
   matches the commit at the old address.
5. Reports the audit trail: which connection did it, on whose authority, and which events were
   recorded.

That conversation is the acceptance test for this spec (section 13).

## 2. Principles

1. **MCP for everything.** Every capability of Pimwell is available over MCP. A page action, an API
   verb, and an MCP tool are the same verb. Exceptions form a short, closed list, each with a reason
   (section 4.3). A table test fails the build when a verb has no MCP exposure and isn't on the list.
2. **Same rules on every surface.** An action is allowed or refused the same way from a page, the API,
   or an assistant. Assistants never exceed the person they act for, and they get less by default.
3. **Power is granted narrowly and visibly.** An assistant connection carries explicit scopes and,
   optionally, a set of organizations or projects it may touch. People see and change all of this in
   one place.
4. **Plans before power.** Any administrative or irreversible action first produces a plan, a precise
   list of effects, and applies only after approval. Approval happens in the conversation for routine
   administration, or out of band for the most dangerous classes (section 6).
5. **Secrets never travel through a model.** A verb that mints or reveals a secret is still available
   over MCP. The secret itself goes to the person through a one-time link, never into the chat, where
   it would reach the model provider's logs (section 7).
6. **Everything is recorded.** Every call records the connection, the person, the plan, and the
   approval, as events in the affected organizations.

## 3. Model

- **Organization.** The tenant, at `<org>.pimwell.com`. Projects live inside it at paths.
- **Project.** A repository, tracker, service, or product, inside one organization.
- **Hub.** The installation itself, at the apex `pimwell.com`. Root people administer it.
- **Roles.**
  - Organization roles: admin, member, reader.
  - Project grants: admin, member, reader. These narrow or widen access per project (section 9).
  - Root: hub-wide.
- **Connection.** An approved assistant (OAuth grant), acting for one person, with scopes and an
  optional resource set.

## 4. MCP surface

### 4.1 Endpoints

| Endpoint | Resource | Carries |
| --- | --- | --- |
| `https://<org>.pimwell.com/mcp` | that organization | organization and project verbs, as today |
| `https://pimwell.com/mcp` | the hub | hub verbs (organizations, sign-in rules, providers, roots) and cross-organization verbs (`project_move`, `org_list`) |

- The hub endpoint is new. It binds `resource = https://pimwell.com/mcp` exactly, under the same
  rules as MCP spec 4.2. A hub token can't be presented to an organization endpoint, and the reverse
  is also impossible.
- **One connector for the owner.** To make "use normal chat" practical, a hub connection may also call
  organization verbs by naming the organization in an `org` parameter. Those calls must stay inside
  the connection's resource set (section 5.2). The per-organization endpoints remain for people who
  want one connector per organization.

### 4.2 Scopes

| Scope | Covers | Default at consent |
| --- | --- | --- |
| `read` | queries | on |
| `write` | ordinary commands: post, create project, edit | on |
| `admin` | organization administration: members, invites, project grants, helpers, archive, project settings | off; the person must tick it |
| `hub` | hub administration: create or archive organizations, sign-in rules, providers, roots | off; root only; tick and fresh proof at consent |
| `secrets` | verbs that mint or rotate credentials (one-time-link delivery only, section 7) | off |

- The effective permission for a call is `exposed(verb) AND scope_granted AND in_resource_set AND
  rank(person's current role) >= verb.minRole`. MCP spec 8.1's ceiling of "member" is replaced by
  the scopes above.
- A grant holding `admin` or `hub` is an **elevated connection**:
  - its access token lives at most 1 hour (the default stays 24 hours for others);
  - the grant expires after 7 days unless re-approved;
  - it is listed under "elevated" on the person's connections page.

### 4.3 Never available over MCP (the closed list)

| Verb | Reason |
| --- | --- |
| `bootstrap` | creates the first root; runs once, by the installer |
| `oauth.grant.approve`, consent itself | an assistant must never approve its own access |
| `login.request`, `login.verify`, Google sign-in | sign-in is a browser ceremony |
| `plan.approve` with out-of-band class | the approval is the human step (section 6) |

Everything else is exposed. This includes `token.*`, `agent.*`, `session.*`, `invite.*` and
`consent.*`, under the scope and plan rules above, and under section 7 for anything returning a secret.

### 4.4 Tool generation and discovery

- Unchanged from MCP spec 8.5, with two changes. `tools/list` reflects scopes and the resource set,
  and every elevated tool's description starts with "Admin." or "Hub admin." plus a one-line summary
  of its plan class.
- New read tool `capabilities`. It returns what this connection can do and why not: missing scopes,
  role, and resource set. This lets an assistant tell the person exactly what to grant instead of
  failing vaguely.

## 5. Scoped permissions and the sandbox

### 5.1 Scopes, chosen at consent

The consent page shows the scopes as checkboxes with plain descriptions, plus the resource set. People
can narrow an existing connection at any time from their connections page. Widening it needs a new
consent.

### 5.2 Resource sets

A connection may be limited to listed organizations and, within them, listed projects.
- **Default:** organization endpoints cover just that organization; hub connections cover all of the
  person's organizations.
- **Narrowing:** for example, "this connection may only touch project `pricebench`". Out-of-set calls
  fail with `forbidden: outside this connection's resources` and change nothing.
- **New resources:** an organization or project created by a connection joins that connection's set,
  so the assistant can finish what it started.

### 5.3 Sandbox organizations

A sandbox is an organization flagged `sandbox`. It is a safe place for assistants and people to try
administration and automation.
- Anyone with `write` may create one. It is named `sbx-<word>-<word>` and owned by its creator.
- It can't send email, can't deploy, and can't reach outside the hub. It holds no sign-in rules.
  Its projects can't be moved out of it, except by copy with approval.
- Inside a sandbox, plans auto-approve: the conversation's confirmation is enough at every class.
- Sandboxes expire after 30 days unless extended; expiry archives, never deletes.
- `sandbox_create`, `sandbox_list`, `sandbox_extend` and `sandbox_archive` are tools.

### 5.4 Dry run everywhere

Every command verb accepts `dry_run: true` and returns the plan without applying it. That makes
"what would happen if" free to ask from any surface.

## 6. Plans and approval

### 6.1 Plans

An administrative command, meaning any verb with `admin` or `hub` scope or marked destructive, doesn't
act when first called. It returns a plan:

```
plan_id, verb, params (normalized), effects: [ {what, where, reversible} ], class, expires_at (15 min),
approve_url (class B and C), requested_by (person, connection)
```

The assistant then calls `plan_apply` with `plan_id`. If the world changed since the plan was made,
for example the target slug was taken, applying fails with the reason and nothing happens. The
assistant asks for a fresh plan.

### 6.2 Classes

| Class | Examples | Approval |
| --- | --- | --- |
| A, routine | create project, invite a member, create a sandbox, rename | the person confirms in chat: the assistant passes `confirm: true` to `plan_apply` |
| B, consequential | create an organization, move a project, change roles, add a sign-in rule, rotate a provider key, archive | in chat, or by following `approve_url`; the person picks the mode per connection at consent, and the default is the link |
| C, dangerous | add or remove a root, delete anything, change the hub's providers' active key with no rollback, disable sign-in | always the link, with fresh proof, in the browser |

- **Why links.** In-chat confirmation slows prompt injection but doesn't stop it, because the model
  produces both the request and the "yes". A link opens on pimwell.com, shows the plan, and needs the
  person's real session. That is a real boundary. Class B lets the owner trade it for speed per
  connection. Class C never does.
- **Sandboxes** treat B and C as A (section 5.3).
- **Elicitation.** When a client supports MCP elicitation, class A and B confirmations use it rather
  than free text.

### 6.3 Pages

`https://pimwell.com/plans/<plan_id>` shows the plan, who asked, through which connection, and its
effects, with Approve and Decline buttons. Approved, declined, applied and expired plans stay listed
on the person's connections page and in the organizations' events.

## 7. Secrets over MCP

- A verb that returns a secret (`token_create`, `session_git`, `agent_create` with a token, provider
  key reveal) returns, over MCP, a `reveal_url`: a one-time pimwell.com link valid for 10 minutes.
  The link requires the same person's browser session and shows the secret once. The tool result says
  "the credential is ready; open this link to copy it" and never includes the secret.
- A verb that accepts a secret works the same way in reverse: for example, adding a provider key from
  chat. The tool returns a `submit_url` where the person pastes it. An assistant can't pass the
  secret as a parameter, and a parameter that looks like a key is refused.
- On pages and the API the existing behavior stays: shown once, directly.

## 8. Organization and project administration

### 8.1 Organizations (hub scope; root, or anyone allowed by a hub setting later)

| Verb | Class | Notes |
| --- | --- | --- |
| `org.create` `{slug, display_name}` | B | creator becomes admin; slug rules as tenants; reserved labels refused |
| `org.list` | read | the person's organizations; root sees all |
| `org.rename` `{org, display_name}` | A | the slug never changes; addresses stay stable |
| `org.archive` / `org.unarchive` | B | archive cascades as tenant archive does today |
| `org.settings` | read and A | default project access, helper policy |

### 8.2 Members and access (organization admin)

| Verb | Class | Notes |
| --- | --- | --- |
| `member.list` | read | people and helpers, roles, project grants, last active |
| `invite.create`, `invite.list`, `invite.revoke` | A | existing verbs, now over MCP |
| `member.set_role` `{org, person, role}` | B | never above the caller's own role |
| `member.remove` | B | revokes their sessions and connections in that organization |
| `project.grant` / `project.revoke_grant` `{project, person, role}` | A | per-project access (section 9) |
| `agent.*`, `token.*` | A or B, secrets per section 7 | existing verbs |
| `connection.list` / `connection.revoke` | read and A | every assistant connection touching the organization |

### 8.3 Projects

| Verb | Class | Notes |
| --- | --- | --- |
| `project.create` `{kind: repo, ...}` | A | a repo project creates its Ardi repository in the same step |
| `project.rename`, `project.settings` | A | |
| `project.archive` / `project.unarchive` | B | existing verbs |
| `project.move` `{project, from_org, to_org, new_slug?}` | B | section 8.4 |
| `project.copy` | B | as move, but the source stays active |

### 8.4 Moving a project

The caller must be admin of the project's current organization and at least member of the target.
The plan lists these effects, which apply in order and are resumable by `plan_id`:

1. Reserve the target project row in state `moving`.
2. Copy the repository server-side into the target organization in Ardi, with all refs and objects.
   This needs an Ardi verb, `repo.transfer` or `repo.copy_from`; see section 11. The hub never pipes
   packs through itself.
3. Verify: every ref in the target equals the source.
4. Flip:
   - the target becomes `active`;
   - the source becomes `moved`, with `moved_to` pointing at the target;
   - tasks, conversations, links and deploy records keyed by project id follow the project, because
     ids are shared rather than copied;
   - the source organization keeps its historical events, and both organizations get a
     `project.move` event.
5. Old address:
   - pages answer 301 to the new address;
   - git fetches get a clear "moved to `<new url>`" error, with no silent redirect on push;
   - the source repository becomes read-only and is archived, never deleted.
6. Access in the target organization follows its membership. Per-project grants from the source don't
   carry over, and the plan lists who loses access.

## 9. Project-level access

The roadmap's model correction: organizations are open to their members by default, and some projects
need different access.

- `project_grant(project_id, identity_id, role)` gives a person or helper a role on one project.
  They don't need to be a member of the organization; they then see only that project.
- `project.visibility`:
  - `org`, the default: members see it.
  - `restricted`: only project grants and organization admins see it.
- The effective role on a project is the maximum of the organization role (unless the project is
  restricted) and the project grant.
- Sign-in grants (identity spec, Google amendment) may target a project as well as an organization.
  The Commons interim tenant then folds into the organization as a restricted project with domain-wide
  grants.

## 10. Model providers and credentials

### 10.1 What the hub needs

Pimwell uses language models for diagnosis, estimates, triage, summaries, and helpers. It needs
provider credentials and a mapping from purposes to models.

| Purpose | Default model (OpenAI, checked 2026-10-07) | Notes |
| --- | --- | --- |
| `deep`: diagnosis, cost estimates, the situation workflow | `gpt-6-astra` | highest intelligence |
| `reasoning`: summaries, plans, assignment proposals | `gpt-6.1-sol` | balanced |
| `fast`: titles, classification fallback | `gpt-6-luna` | fastest, cheapest |
| `code`: helper coding through Pi | `gpt-6.1-sol` | tool calling through the Responses API; Pi runs the loop (10.5) |
| `decision`: typed decisions | TypeSafe Jev, later Cloudflare Clef | `docs/direction.md` |

The mapping is data, edited in admin. It isn't code. The admin page flags when a provider offers a newer model family than a purpose uses.

### 10.2 Storage

- Table `provider_credential`:
  - `id`, `provider` (`openai`, `anthropic`, `typesafe`, ...), `label`;
  - `secret_ciphertext`, `secret_iv`, `fingerprint` (provider prefix plus the last 4 characters);
  - `scope`: `hub`, or one organization;
  - `status`: `active`, `standby` or `retired`;
  - `verified_at`, `last_used_at`, `last_error`, `created_by`, `created_at`, `retired_at`.
- Secrets are encrypted with AES-GCM under a Worker secret, `HUB_SECRETS_KEY`. D1 alone never holds
  a usable key. Rotating `HUB_SECRETS_KEY` re-encrypts every row with a verb, `provider.rekey`
  (class C).
- Table `model_route`:
  - `purpose`, `scope` (hub or organization), `provider`, `model`, `credential_id` (nullable: the
    active credential for the provider in that scope);
  - `updated_by`, `updated_at`.
- Organization scope overrides hub scope, so an organization can bring its own key and its own models.

### 10.3 Rotation, made easy

1. Add the new key as `standby`, from the page or through a `submit_url` from chat (section 7). The
   hub verifies it immediately with a cheap provider call and records the result.
2. Promote it to `active`. This is class B. The previous active key becomes `standby`, so rollback is
   one action.
3. Retire the old key after the new one has served traffic. The page suggests this after 24 hours
   without errors.

Each key on the page shows its fingerprint, status, last verified, last used, recent error, and what
it serves. Nobody needs to remember where a key is used.

### 10.4 The admin view, "Models and keys"

One page, plus the same data from the `provider_status` tool:
- **Needed:** each purpose, and whether it has a working route. A purpose with no credential shows
  "needed: add an OpenAI key" with an Add button.
- **In use:** each purpose's provider, model, credential fingerprint, and calls and errors over the
  last 24 hours.
- **Change:** edit the model per purpose from the provider's live model list; add, promote or retire
  keys; test a route with a one-line prompt.

### 10.5 Pi for tool execution

When a purpose needs tools, such as editing code, running commands, or reading files, the hub doesn't
grow its own agent loop. It runs the Pi coding agent (`docs/direction.md`) in a sandbox with:
- the route's credential, injected for that run only;
- the repository checked out from Ardi;
- the session recorded like any helper's.

Subscriptions as well as API keys are supported per section 10.2's provider list, for example an
`openai-subscription` provider. The sandbox host, either Cloudflare Containers or a Workers sandbox,
is chosen in Pi's own plan.

### 10.6 Calling models

- One internal module, `models.ask(purpose, input, {org})`. It resolves the route, decrypts the key in
  memory, calls the provider, and records usage and errors against the credential and the purpose.
- Every model-produced answer that becomes a record (diagnosis, estimate, summary) stores its
  provider, model, and purpose beside it (`docs/direction.md`: the model used is recorded).
- Responses API for OpenAI. Streaming isn't needed for v1 records.

## 11. Dependencies

| Dependency | Owner | Needed for |
| --- | --- | --- |
| Ardi `repo.transfer` or `repo.copy_from` across tenants, server-side, preserving all refs | Ardi session | project move and copy (section 8.4) |
| Ardi accepts large pushes in one request | Ardi session, in progress | imports |
| `HUB_SECRETS_KEY` Worker secret | this spec, phase P1 | providers |

## 12. Phases

| Phase | Delivers | Exit |
| --- | --- | --- |
| P1 | Providers and credentials: tables, encryption, verify, rotation, `models.ask`, the "Models and keys" page and tools; OpenAI seeded from the owner's key | the page shows every purpose routed and verified; rotation works end to end |
| P2 | MCP parity: hub endpoint, `admin`, `hub` and `secrets` scopes, resource sets, `capabilities`, closed-list table test, secrets by link | an elevated connection lists every non-closed verb |
| P3 | Plans and approval: plan records, classes, `plan_apply`, approval pages, elicitation | class B and C flows from chat |
| P4 | Organizations and project access: `org.*`, `member.*`, project grants and visibility; Commons folded in | owner creates an organization from chat |
| P5 | Project move and copy, with the Ardi transfer verb | the acceptance test passes |
| P6 | Sandbox organizations | an assistant creates and uses a sandbox without approvals |

## 13. Acceptance test

Run by the owner, in an ordinary Claude or ChatGPT chat with one Pimwell hub connection holding
`read write admin hub`:
1. "What can you do here?" `capabilities` lists organization and project administration.
2. "Create an organization called Northwind." The assistant shows a class B plan. The owner approves by
   link, or in chat if they chose that mode. `org_list` shows it.
3. "Move AgentFeed from our organization to Northwind." The plan lists the effects in section 8.4. The
   owner approves and the assistant applies it.
4. `git ls-remote https://northwind.pimwell.com/agentfeed.git` shows the same main as before the move.
   The old address says "moved".
5. "Show me what you did." `event_list` in both organizations shows the plans, approvals, and effects,
   attributed to the connection and the owner.
6. Negative: a connection without `hub` gets a clear "needs the hub scope" from `capabilities` and from
   `org_create`, and nothing changes.

## 14. Testing

- Table test: every verb is exposed over MCP or on the closed list.
- Scope, resource set, and role matrix tests, per verb class.
- Plans: staleness, expiry, double apply, approval by a different person (refused), approval link
  without fresh proof for class C (refused).
- Secrets: no tool result contains a value matching any credential pattern; reveal links are one-time
  and same-person.
- Providers: encryption round trip; verify failure keeps a key in `standby`; rotation and rollback;
  usage recorded; organization overrides hub.
- Move: resumability after failure at each step; refs verified; old address behavior.

## 15. Open questions, ruled for now

- Q1: May non-root people create organizations? Ruled: root only in v1; a hub setting opens it later.
- Q2: Is the hub connection allowed to call organization verbs? Ruled: yes, with `org` named and within
  the resource set. This keeps "normal chat" to one connector.
- Q3: Class B default mode? Ruled: link, switchable to in-chat per connection at consent.
