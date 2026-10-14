# Project kinds

`src/projectFeatures.ts` is the capability table for project creation, project-page tabs and feature checks in verbs. Project-scoped MCP discovery uses this table to select tool families; it never changes role or grant scopes.

| Kind | Features |
| --- | --- |
| repo | Docket, repository, files |
| tracker | Docket |
| wiki | Wiki pages, files |
| workspace | Docket, wiki pages, knowledge base, files, people |

Wiki tabs open the page list, editor and revision history; see [wiki pages](wiki.md). Knowledge, project files and project people remain upcoming features, with clearly marked coming-soon sections rather than repository files or organization membership. The repository's source-file browser is part of the repository feature.

Members can create projects over `project_create`, `/api/project.create`, or the kind picker at `/projects/new`. Project navigation opens the project overview so non-Docket kinds remain reachable. Explicit Docket and repository operations reject projects without the required capability; hidden channel and agent-source projects remain excluded from ordinary project resolution. Archiving remains admin-only.

## Generated channel access

A top-level workspace created by an agent grants only that authenticated creator membership in its newly generated team and ops channels. The grant commits atomically with each channel, records the creator as `added_by`, and uses ordinary channel read/post policy (including mutes, the kill switch and later human removal). Other agents receive no access. Taken names are skipped without granting access to the existing channel; retries cannot restore removed membership. This is creation-time only: no backfill, self-join endpoint, grant for other project kinds or namespaced projects, or change to human-only channel membership management.

## Project lifecycle

Agents may call `project_delete {project}` over organization MCP or `project.delete` over the API without archiving or web confirmation only for their own throwaway projects: the slug must start with `tmp-`, the original `project.create` event must name the caller as creator, and there must be no other active human member on the project or its owned default channels. Other agents and an empty membership are allowed. Projects have no separate member roster; explicit membership is stored on their channels, not inferred from organization membership or workspace contacts. Unknown creators fail closed. The same full deletion cascade runs, with a `project.deleted` audit event naming the caller. Failed external purges leave the project archived and retryable through the same authorized call.

Everything else retains the web-only rule. Admins archive projects from the organization home’s project list. The archive lists a permanent delete form: type the exact project slug. Deletion requires an admin human's browser cookie session with proof no older than ten minutes. Human bearer sessions, OAuth and the Playground cannot delete, and agents cannot use this route to delete non-throwaway projects.

Web deletion requires an archived project; authorized agent throwaway deletion archives it internally. It removes work and its comments, links, dependencies, proposals and followers; mail, response state and mail action reservations; contacts, their connections and links; document share/dispatch history; wiki/KB/research revisions; file revisions, upload capabilities and private R2 objects; reviews, code indexes, telemetry and project usage; and default project channels, including their Conversation messages, outboxes, presence and Inbox entries. Organization identities and memberships are not project people and are retained. Default channels created now have an atomic ownership record in `meta`; older defaults are recognized by their exact creation time, name and display name, excluding independently created channels. A similar name alone never authorizes deletion.

Before any external purge, the entire D1 cascade is trialled in a batch: deferred foreign keys are checked explicitly and an intentional terminal constraint failure rolls back all trial changes. An uncovered FK therefore leaves conversations, inboxes, R2 and Artifacts intact. The schema-coverage test requires every D1 table with a `project_id` column to be covered or explicitly exempted with a reason. External stores are then purged idempotently before the D1 cascade and one count-bearing deletion event commit together. A failed purge leaves the archived project available for a confirmed retry, but it cannot be unarchived after deletion starts. Conversation objects retain only a binding and deletion tombstone, which refuses late posts and alarms. Repo deletion checks the Artifacts tenant/project ownership marker and removes owned scratch repositories and replay objects too; a legacy unmapped repository must be migrated first. Cross-project references are detached, not used to delete the other project’s content. Direct/group chats belong to the organization, not a workspace: their descriptors, membership, messages and Inbox update logs are retained. Inbox updates for deleted default channels are removed.

The project kind column is not CHECK-constrained; these kinds require no database migration.
