# Repositories within projects

A code project can have multiple repositories. Repository names are 1–63 lowercase
letters, digits or hyphens, beginning with a letter or digit, and unique within the
project. Exactly one is the default. Existing repositories retain the name
`default` and their existing Artifacts storage location. Every ordinary project can
host code: `project_update {project, add: ["repo"]}` creates its default repository,
or its first `repo_create` becomes the default. Both enable the stored `repo` part.
Keep source in the existing project, never a separate `<name>-source` project.

## Addresses and creation

- `https://<org>.pimwell.com/<project>.git` always selects the default repository.
- `https://<org>.pimwell.com/<project>/<name>.git` selects a named repository,
  including an explicitly named default.
- `repo_create {project, name}` (MCP), or `POST /api/repo.create`, requires the same
  member permission as project creation. Repeating the same create returns the
  existing repository. Names must be created explicitly; pushing an unknown name
  never creates storage or a mapping.
- `repo_list` returns repository names, their project, default status, clone URLs
  and the caller's push access. It accepts optional `project` and `repo` filters.

All repositories share their project's access boundary. Git uses the existing
credential helper and rechecks live credentials, operator membership and push
permission before publishing. Non-default repositories use the same private
staging, append-only history validation, rewrite preservation and protected
branch/tag rules as the default. See [git-history.md](git-history.md).
Agent source repositories retain their separate, narrower access rules.
Git authorization reads the live session, tenant, identity, parent token,
agent/operator memberships, operator, active project and tenant-scoped storage
mapping in one D1 batch (caller-only reads omit the project lookup). The Git service
starts this request-local lookup alongside routing and passes its result to the
Artifacts handler once; routing never grants access, grants never survive the
request, and live storage ownership is still checked before fetching Git data. The existing credential
policy and role caps consume that request-local snapshot; none of those rows are
cached between requests. Git routing overlaps its independent tenant/backend reads.
The hub overlaps its own tenant/tracing lookup with the Git service, which still
independently validates the tenant and caller; the hub also checks its tenant
result and discards any proxy response for a missing or inactive organization.

## Reading, review and references

`repo_branches`, `repo_log`, `repo_commit`, `repo_file`, `repo_diff` and
`review_request` take an optional `repo` name. Omission selects the default.
`repo_search` instead searches all repositories within the project unless a name
is supplied. Search matches carry the repository; the overall limit bounds the
combined matching-line result, with per-repository results and coverage included.

Artifacts file views use one request-local authorized repository read for directory
identification and file retrieval. Immutable commit metadata, trees and bounded
file contents are cached with account, tenant ID, project ID and storage repository
in the key. Full-commit file/directory results can skip upstream resolution on a
warm hit, but only after a fresh caller and repository-mapping check. Cold reads
verify the storage ownership marker; indexed commits can supply their root tree.
Branches, tags and HEAD are resolved afresh, never cached as immutable revisions.
Browser readers reuse their current live authorization rather than minting a second
Git credential. Agent-source repositories retain their narrower live grant checks.

Commit references are `<project>@<full-sha>` for the default and
`<project>/<name>@<full-sha>` otherwise. Push sync tracks named repositories
independently and links commit mentions of `<project>#<number>` to work items,
using the repository-qualified reference. Initial named-repository history also
gets links; historical imports remain quiet in project ops channels.
The same SHA in two repositories does not merge their pusher attribution,
commit/work associations or derived history traversal.

Reviews retain a repository name alongside their project-wide review number.
App registration and deploy recording accept `repo`; omit it for the default.
App declaration checks read that repository, telemetry-derived deployments inherit
it from their registered app, and Site app records expose it. Deployment commit
references and commit/deploy associations retain the repository.

## Workbench

The project explorer's Code branch lists repositories default-first, each with
Files, Commits, Reviews and a copyable clone URL. The Code toolbar's quiet
New repository disclosure posts an inline name to `repo.create`; readers cannot
create repositories. Workspaces with an attached repository get the same branch.

Code and file views use `/<project>/code?repo=<name>` and
`/<project>/files?repo=<name>`. Commit selection (`c`), file selection (`f`),
directory (`path`), branch (`ref`) and pagination retain that repository.
Review URLs also carry `repo`, and their lists filter by repository. Omitted
repository parameters select the default, preserving old single-repository URLs.
Pane keys include the repository so equal SHAs or filenames cannot reuse another
repository's inspector. Item commit links and deploy destinations use these URLs;
repository-qualified commit references retain their existing syntax.

Review search results, review lists, app rows and deploy rows show short
repository names when the project has more than one repository. Recorded full
commit references remain explicit evidence rather than shortened labels.

The workbench audit includes a synthetic three-repository project with named
commit, file, review and item-link views. Run it with
`WORKBENCH_PHASE=after WORKBENCH_PAGES=multiCode,multiCommit,multiFiles,multiItem,multiReviews node scripts/workbench-screenshots.mjs`.
It exercises repository-preserving selection/history and clone controls at
1440, 1920 and phone sizes without production credentials or network access.

## Storage and deletion

`repository` maps `(project_id, name)` to an internal Artifacts `storage_name`.
A partial unique index enforces one default per project. Additional storage names
are deterministic hashes of the project ID and repository name, not public paths;
renaming a public project does not require moving named Git storage.
`git_repository` remains the legacy migration-completion marker. Its insert
trigger seeds a default mapping for existing provisioning and agent-source paths.

The additive migration copies only derived commit metadata into
`repository_commit`, keyed by project, repository and SHA; no Git objects or
Artifacts repositories move. A trigger keeps legacy default-repository metadata
writes compatible. Named pushes write their own graph entries. Default sync
checkpoints remain in `code_sync`; named checkpoints use `repository_sync`.
Push recovery records already carry the exact storage repository.

Project deletion preflights the full D1 cascade, then purges every mapped Git
repository, private push staging and replay data before committing deletion.
The same ownership checks apply to every purge. Tenant deletion also purges all
repositories. The project schema-coverage test includes repository mappings,
per-repository graphs and sync checkpoints.
