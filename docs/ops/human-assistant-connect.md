# Connect a human hosted assistant

The tenant's **Assistant → Connect ChatGPT or Claude** page at
`https://<tenant>.pimwell.com/assistant/connect` supplies the exact human MCP
endpoint for the authenticated browser's active organization, identity and role.
The apex `/me` Assistants section links to guides for the person's own active
memberships. Chat and Tools both link to it. No query parameter selects a tenant,
identity or endpoint. Guidance itself creates no grant, consent, model call or
assistant conversation; it is not a token or OAuth shortcut. Unknown/archived
organizations, removed members, anonymous/expired sessions, agents and bearer
sessions receive neutral no-store refusals. The successful page is also no-store.

For MCC, the human endpoint is **https://mcc.pimwell.com/mcp**, not
`/agent/mcp`. Start a custom remote MCP connector in the hosted client's settings,
then use browser OAuth at **https://pimwell.com**. Client settings labels, plans,
custom-connector availability and workspace-admin controls vary; the guide does
not promise that any particular client offers this option or has been tested.
Never substitute an agent token, paste secrets into chat, or share callback/sign-in
URLs. Login proof, current membership, resource authorization and explicit consent
are not relaxed by this page.

## Identity and consent

- Different email addresses are distinct identities. Verify the address on the
  actual consent page, even if the setup-guide browser showed the intended one.
  Sign out and sign in as the intended eligible identity when necessary.
- Review organization, app-supplied name, destination and requested tools. Reject
  unsolicited requests. `read` covers exposed lookups; `write` adds ordinary
  supported changes subject to role. Admin roles do not expose every admin,
  credential or access-management tool to MCP.
- After connecting, call `whoami` and inspect its identity, tenant/role and
  `connection.scopes`. Check a permitted read before authorizing changes.
- A write acceptance test needs the human's explicit authorization for one benign
  change to a specified record they control. Inspect visible actor and history;
  uncertain writes must be reconciled, not blindly repeated.
- Revoke under apex `/me` → Assistants, and disconnect in the client. Revocation
  stops subsequent authorized calls; it does not undo prior changes.

The historical distinct-address issue [#90](https://mcc.pimwell.com/pimwell/w/90)
records admission of Brian's root MCC work identity while agent outbound replies
required explicit active membership. That record is **not a current-membership
observation**, nor proof that human OAuth will fail: root authority and outbound
mail eligibility have separate code paths. This increment makes no real identity
or membership changes. Check the current consenting identity through normal
read-only introspection/consent, rather than granting access to force a test.

## Server support versus hosted-client acceptance

The current authorization metadata advertises DCR, authorization code and refresh,
S256 PKCE, `read`/`write`, and
`client_id_metadata_document_supported: false`. Return destinations must match
Pimwell's approved redirect patterns. No new client registration or redirect
allowlist is created by this guide. CIMD absence alone is **not** evidence a
hosted client is incompatible. An actual failure needs client-specific,
non-secret evidence before changing interoperability code.

For **each actual ChatGPT/Claude client**, remaining #144 acceptance is:

1. Record client/plan/workspace custom-server availability and the consenting
   human identity (no credentials or private callback URLs).
2. Follow real browser OAuth, review consent, call `whoami`, and check one allowed
   read and one denied resource boundary.
3. With explicit consent, make the one benign write and inspect actor/history.
4. Observe refresh on that same connection; then revoke and confirm subsequent
   tool calls are refused. Reconcile any uncertain write before retrying.
5. Record real registration/redirect/client errors with approximate time and
   redacted error text, not tokens, codes or full OAuth URLs.

A server metadata GET, anonymous MCP challenge, synthetic local OAuth suite,
agent MCP connection, or built-in Assistant test is **not** hosted-client
acceptance. The coding worker has no consenting human hosted-client session or
client-plan/workspace UI capability; that acceptance requires the human/operator.
Keep #144 open until that evidence exists.

## Local regression evidence

`test/assistant-connect.test.ts` exercises the actual Worker route for reader,
member and admin browser identities, no grant/model/consent/conversation/event
creation, inert directory text, query spoofing, outside-tenant and unknown-host
refusal, expired/removed/archived access, and native/bearer agent denial. Chat,
Tools and account discovery are checked with membership-filtered links.

The disposable `scripts/test-chat-browser.mjs` harness also checks actual shipped
HTML/assets in Chromium at 1440/390/320 widths: follow the Chat link, select the
read-only exact endpoint by keyboard, inspect current reader identity, follow the
account/revoke location and return through the guide link, with no horizontal
overflow. All sessions/D1/DOs are synthetic local fixtures; outbound services are
denied. It does not exercise a hosted ChatGPT/Claude session or grant acceptance.

See [MCP contract](mcp-contract.md) and [generated tool inventory](../generated/mcp-tools.md).
