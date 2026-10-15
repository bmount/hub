# Project kinds

`src/projectFeatures.ts` defines creation templates. The stored `project.parts` JSON set is the source of truth for feature checks, navigation, the overview, search and project-scoped MCP tool families. Kind stays unchanged. Migration 0039 seeds existing projects from their kind and adds `repo` wherever a repository already exists. New projects are seeded at insertion; repository creation enables `repo`. Discovery never changes roles or grant scopes.

| Kind | Features |
| --- | --- |
| repo | Docket, repository, files |
| tracker | Docket |
| wiki | Wiki pages, files |
| workspace | Docket, wiki pages, knowledge base, files, people |

Wiki tabs open the page list, editor and revision history; see [wiki pages](wiki.md). Knowledge/research, uploaded files and contact people are project content, not repository files or organization membership. The source-file browser belongs to `repo`.

Members add parts with `project_update {project, add: ["repo", "wiki"]}` or `POST /api/project.update`. Use the existing project; never create a separate `<name>-source` project. Adding `repo` provisions its default `<project>.git` if no repository exists. `repo_create` works in every ordinary project and enables `repo`. Both tools remain discoverable on project MCP endpoints even when repo is absent.

`remove` accepts the same part names (`docket`, `repo`, `wiki`, `knowledge`, `files`, `people`). Only empty parts may be removed. Work items, retained revisions (including deleted pages/files), research, pending uploads, contacts/connections and repository records block removal with counts; removal never deletes content. Wiki owns the shared wiki/KB/research revision store, so research also prevents removing wiki. Adding knowledge also enables wiki, its page/history store; removing wiki requires removing empty knowledge in the same call. Archived/deleting projects reject updates. Tenant and pinned-project boundaries still apply.

Members can create projects over `project_create`, `/api/project.create`, or the kind picker at `/projects/new`. Project navigation opens the project overview so non-Docket kinds remain reachable. Explicit Docket and repository operations reject projects without the required capability; hidden channel and agent-source projects remain excluded from ordinary project resolution. Archiving remains admin-only.

## Generated channel access

A top-level workspace created by an agent grants only that authenticated creator membership in its newly generated team and ops channels. The grant commits atomically with each channel, records the creator as `added_by`, and uses ordinary channel read/post policy (including mutes, the kill switch and later human removal). Other agents receive no access. Taken names are skipped without granting access to the existing channel; retries cannot restore removed membership. This is creation-time only: no backfill, self-join endpoint, grant for other project kinds or namespaced projects, or change to human-only channel membership management.

## Project lifecycle

Agents may call `project_delete {project}` over organization MCP or `project.delete` over the API without archiving or web confirmation only for their own throwaway projects: the slug must start with `tmp-`, the original `project.create` event must name the caller as creator, and there must be no other active human member on the project or its owned default channels. Other agents and an empty membership are allowed. Projects have no separate member roster; explicit membership is stored on their channels, not inferred from organization membership or workspace contacts. Unknown creators fail closed. The same full deletion cascade runs, with a `project.deleted` audit event naming the caller. Failed external purges leave the project archived and retryable through the same authorized call.

Everything else retains the web-only rule. Admins archive projects from the organization home’s project list. The archive lists a permanent delete form: type the exact project slug. Deletion requires an admin human's browser cookie session with proof no older than ten minutes. Human bearer sessions, OAuth and the Playground cannot delete, and agents cannot use this route to delete non-throwaway projects.

Web deletion requires an archived project; authorized agent throwaway deletion archives it internally. It removes work and its comments, links, dependencies, proposals and followers; mail, response state and mail action reservations; contacts, their connections and links; document share/dispatch history; wiki/KB/research revisions; file revisions, upload capabilities and private R2 objects; reviews, code indexes, telemetry and project usage; and default project channels, including their Conversation messages, outboxes, presence and Inbox entries. Organization identities and memberships are not project people and are retained. Default channels created now have an atomic ownership record in `meta`; older defaults are recognized by their exact creation time, name and display name, excluding independently created channels. A similar name alone never authorizes deletion.

Before any external purge, the entire D1 cascade is trialled in a batch: deferred foreign keys are checked explicitly and an intentional terminal constraint failure rolls back all trial changes. An uncovered FK therefore leaves conversations, inboxes, R2 and Artifacts intact. The schema-coverage test requires every D1 table with a `project_id` column to be covered or explicitly exempted with a reason. External stores are then purged idempotently before the D1 cascade and one count-bearing deletion event commit together. A failed purge leaves the archived project available for a confirmed retry, but it cannot be unarchived after deletion starts. Conversation objects retain only a binding and deletion tombstone, which refuses late posts and alarms. Repo deletion checks the Artifacts tenant/project ownership marker and removes owned scratch repositories and replay objects too; a legacy unmapped repository must be migrated first. Cross-project references are detached, not used to delete the other project’s content. Direct/group chats belong to the organization, not a workspace: their descriptors, membership, messages and Inbox update logs are retained. Inbox updates for deleted default channels are removed.

Deletion counts share one D1 batch with archiving the owned projects. Owned Conversation purges settle before Inbox cleanup, so a conversation drain cannot recreate a deleted Inbox entry. Inbox purges run with at most ten concurrent calls; independent R2 project-prefix purges run with at most three. All started purges settle before a failed deletion returns, and the final D1 cascade still waits for every external store to succeed.

Project kind remains the creation template; adding a part changes only the stored set, not kind or access permissions.
