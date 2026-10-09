# Pio audit first security increment — 2026-10-08

Tracks [audit quest #95](https://mcc.pimwell.com/pimwell/w/95), [S1 #100](https://mcc.pimwell.com/pimwell/w/100), and [S2 #101](https://mcc.pimwell.com/pimwell/w/101).

The supplied audit reviewed `3014e96`, not a production penetration test. These two paths were verified against current source `14a9659` before implementation. No exploitation is claimed.

## External work URLs

- `linkWork` validates/canonicalizes absolute HTTPS URLs before any write/event. Credentials (including empty userinfo), whitespace, controls, ambiguous backslashes and other schemes are rejected. Plain HTTP is deliberately not approved.
- Work HTML revalidates legacy URL links; invalid links are inert escaped text, not anchors. No destructive legacy-row migration is needed.
- API/MCP metadata describes the rule; tests include create/read/render and legacy attribute-injection examples.
- CSP remains a separate defense-in-depth task, #103; HTML escaping is not URL authorization.

## Mailbox policy

`src/auth/mailAccess.ts` supplies the shared parameterized SQL read predicate:

| Resource | Read permission |
| --- | --- |
| Admitted organization/project mail (`recipient_id IS NULL`) | Authenticated tenant readers |
| Admitted addressed-agent mail | Addressed agent; its human operator with current tenant access; human tenant admin/root |
| Quarantine | Human tenant admin/root only |
| Other tenant's mail | Never through this tenant context, including root/operator |

An agent role never confers a tenant-wide mailbox override. `mine` narrows an authorized query and cannot widen it. Unauthorized IDs are indistinguishable from missing IDs. Operator reassignment and tenant access removal are checked on the next request.

The predicate is applied before `LIMIT` and before loading model evidence, across list/read/proposals, mail HTML and replies, organization home, search, OAuth and headless MCP. Mail-related event summaries in activity, project history, home/project/people timelines are also filtered; outbound event summaries are restricted to authorized mail readers, senders/operators/admins. Sending authorization remains separate and is not expanded.

Regression tests: `test/work-url-security.test.ts`, `test/mail-access.test.ts`; existing mail/outbound/search/proposal suites also run. Clean install uses `npm ci --ignore-scripts`; checks are `npm run typecheck` and `npx vitest run --testTimeout=30000` (the CLI timeout is not a repository config change). No database migration or user/membership mutation is involved.

## Tracking and remaining scope

- Communication: #96 blocked-outgoing UI, #97 bidirectional chat, #98 durable execution/progress loop, #99 empty polling at debug.
- Audit S3–S5: #102–104; S6 dependency/tooling finding: existing #88.
- R1–R3: #105–107; performance P1–P3: #108–110; D1–D3: #111–113; Q1–Q4: #114–117.
- Coverage/freshness #118; resource/project policy #114; attachments existing #86; search disclosure #119; approval previews #120; AI budgets #121.
- Eight AI proposals: #122–129. Project-specific agent grants also relate to existing #94.

The general project-grant policy (#114), privacy of deliberately quoted/published work evidence, indexed search, transactional outbox, attachment extraction, and CSP are not claimed solved by this increment.

Ardi is locally cloned at `/home/pio/projects/ardi` (`6a9e9e4`). It remains unchanged; its Rust/wasm store, tenant/repository Durable Objects, R2 objects, Hub introspection and append-only/fork model are being read for integration context, not expanded.

Operationally the implementation loop is currently active-session-driven: claim/plan → implement → boundary/full tests → push/review → authorized release/smoke checks → record evidence/update work. The durable daemon polls/triages but does not yet autonomously implement or reply; #98 tracks making that claim true. Progress goes into work comments and eligible-member email at milestones. Record release version/deployment and rollback separately only once observed.
