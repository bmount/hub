# Organization lifecycle

The hub home at the apex has a **New organization** form. Signed-out submissions
redirect to sign-in. Any signed-in human can create an organization; its slug
must pass `isValidTenantSlug` and `reserved.ts`, and its display name is required.
Creation atomically inserts the organization and the creator's admin membership.
Existing standing sign-in grants still apply. An atomic per-identity D1 quota
permits three valid creation attempts per day; counter failures fail closed.
No new routing or DNS setup is required: the Worker's `*.pimwell.com/*` route
resolves organizations from D1 immediately.

Human admins manage their own organizations on the hub home, including archived
ones. Root can manage any organization from `/admin/orgs`. Archive and unarchive
require a browser proof no older than ten minutes. Archiving revokes assistant
grants; unarchiving does not restore them.

Deletion is human-only, with a cookie-authenticated web session and proof no
older than ten minutes. The organization must be archived, and its slug must be
typed into the confirmation field. Bearer, agent and assistant connections
cannot delete organizations. These hub verbs are not MCP tools. Organization
forms use native navigation rather than enhanced POST fallback/resubmission.

Deletion first marks the organization as deleting, which prevents unarchiving.
It purges owned Artifacts repositories and temporary push repositories, staged
pushes, project file objects, conversation Durable Objects and member inboxes.
Artifacts deletion checks the existing tenant/project ownership marker; an
unmapped legacy repository must be migrated before deletion when Artifacts is
active. External failures leave the organization archived and retryable, never
reporting a successful deletion with remaining repository data.

The D1 cascade removes tenant-scoped rows, work graph/proposals, contacts,
repository metadata and agent accounts that have no membership elsewhere.
Human identities and agents belonging to other organizations remain. References
from other organizations' audit events to removed sessions/agents are detached,
not deleted. A hub deletion event and a `deleted_tenant` tombstone remain. The
slug stays reserved; purging storage is not permission to reuse the name.

`test/tenant-delete.test.ts` covers the lifecycle, current admin authority,
agent/anonymous refusal, fresh proof, origin and bearer denial, quotas, external
failure/retry and sibling data preservation. `npm run test:browser:chat` also
exercises creation, member invitation, archive and typed deletion through real
web forms on disposable local hosts, without production credentials.
