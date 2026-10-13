# Workspace contacts

Contacts are project content in `workspace` projects. They are not Pimwell identities and do not create or change organization memberships. Organization readers and up can read them; members and up can write. Tenant and project predicates apply to every entity, connection and backlink query. Archived workspaces remain readable but cannot be changed.

## Tools

- `person_upsert`, `person_read`, `person_list`, `person_merge`.
- `company_upsert`, `company_read`, `company_list`.
- `connection_add`, `connection_remove`, `connection_list`.
- `graph_neighbors`, `graph_path`.

The API names use dots instead of the first underscore. All tools take `project`, the workspace slug. Upsert without an ID creates a contact. To replace fields on an existing contact, supply its ID and `expected_revision` from read. Lists return up to 200 rows and a `next_cursor` to pass as `after`; contact lists accept name substring and exact tag filters. Contacts have independent IDs even when their email matches an organization member.

Connections are undirected and typed. A person-company edge can represent an affiliation role such as `founder` or `advisor`. Any person/company pairing is supported. Strength is optional, between 0 and 1. Date is `YYYY-MM-DD`, default today. Source is a reference or note, not fetched content. Do not copy private mailbox evidence into shared contact notes or connection sources.

Person merge requires both current revisions. The target name and nonempty title win; emails, phones and tags are unioned; notes are appended. Connections and backlinks move to the target, connections between the merged people are removed, and the source contact is removed. The revision assertion and mutations share a D1 transaction, so a concurrent edit cannot leave a partial merge.

## Content links

Upsert accepts optional `links`, each with a `kind` and `ref`:

- `item`: work item ID in this workspace.
- `research`: current research page slug in this workspace.
- `file`: current file path in this workspace.
- `mail`: inbound mail ID the caller can read in this organization.

Omitting links preserves them. Supplying links replaces the caller-visible links only. Inaccessible mail links are preserved and never returned; the canonical mailbox predicate is reapplied on each read. Deleted files/research disappear from current backlinks. Entity reads and detail pages include readable backlinks with titles and URLs. Link records are associations, never access grants.

## Graph and web

`graph_neighbors` returns an entity's induced neighborhood at 1–6 hops, including node depth and typed edges. `graph_path` uses breadth-first search to return the shortest introduction path, including its nodes, edges and hop count. Both support a connection-type filter. A disconnected path has `found: false`; a path to itself has zero hops. Traversals refuse graphs above 2,000 entities or 10,000 connections rather than silently omit nodes and claim a wrong shortest path.

`/<workspace>/contacts` lists people or companies, with name/tag filters and a creation form for members. `/<workspace>/contacts/<id>` shows fields, backlinks and the neighborhood graph. The SVG and connection list render on the server. The hashed same-origin graph client enables dragging and zoom; names link to contact pages, and the hops form changes the neighborhood. No external graph library or third-party service is required. MCP supplies field edits, merges and connection management.

`search_query` includes contact names and all stored entity fields in a separate `contacts` group, capped at 20 matches. It does not search backlinks or connection sources.
