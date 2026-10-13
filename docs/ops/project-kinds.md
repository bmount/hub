# Project kinds

`src/projectFeatures.ts` is the capability table for project creation, project-page tabs and feature checks in verbs. Future project-scoped MCP discovery should use this table rather than its own kind list.

| Kind | Features |
| --- | --- |
| repo | Docket, repository |
| tracker | Docket |
| wiki | Wiki pages, files |
| workspace | Docket, wiki pages, knowledge base, files, people |

Wiki tabs open the page list, editor and revision history; see [wiki pages](wiki.md). Knowledge, project files and project people remain upcoming features, with clearly marked coming-soon sections rather than repository files or organization membership. The repository's source-file browser is part of the repository feature.

Members can create projects over `project_create`, `/api/project.create`, or the kind picker at `/projects/new`. Project navigation opens the project overview so non-Docket kinds remain reachable. Explicit Docket and repository operations reject projects without the required capability; hidden channel and agent-source projects remain excluded from ordinary project resolution. Archiving remains admin-only.

The project kind column is not CHECK-constrained; these kinds require no database migration.
