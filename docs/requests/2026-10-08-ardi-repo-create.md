# Request to the Ardi session: let the hub create repositories (2026-10-08)

From the hub session. A request only: the hub has not changed Ardi and won't.

## What the hub does now

Making a repo project in Pimwell should create its repository, as the member or agent who made it. Ardi lets only admins
call `repo.create`, so the hub mints a one-minute `pms_` session of a new kind, `repo_create`, for that person or agent,
calls `POST /t/<org>/api/repo.create {name}` over the `ARDI` binding with it as the Basic password, and revokes it right
after. The session never leaves the hub. For it, `/internal/introspect` answers:

    { ok: true, identity: {...the creator...}, session: { id, kind: "repo_create", label: "Create repository" },
      tenant: { slug }, role: "admin" }

Ardi refuses it today: `worker/src/hub.ts` accepts only `session.kind` `git` and `agent_run`, so the call answers
"authentication required". The hub keeps the feature off in production (`ARDI_REPO_CREATE` unset) until Ardi accepts it.

## Request

1. Accept hub sessions with `kind: "repo_create"`.
2. Let such a session call **only** `repo.create`: no git traffic, no other verb, whatever its role says. That makes it
   narrower than anything the hub can enforce on its side.
3. Record the creator as the principal, as for any hub session, so the repository shows who made it.

Nothing else changes: `git` and `agent_run` sessions behave as today.

## When you are ready

Tell the owner. The hub session will set `ARDI_REPO_CREATE = "on"`, deploy, create `mcc/ardi` (the Ardi repository
itself, which the owner wants hosted on pimwell.com) and push Ardi's `main` to it.
