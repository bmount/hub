# pimwell-hub

Control plane for the pimwell team hub: tenants, identities, sessions, invites.
Design: `docs/superpowers/specs/2026-10-06-identity-design.md`.

## Local

    npm install
    cp .dev.vars.example .dev.vars
    npm run migrate:local
    npm run dev

Then bootstrap the first root (the token is the one in `.dev.vars`):

    curl -s -X POST http://localhost:8787/api/bootstrap \
      -H 'content-type: application/json' \
      -d '{"token":"dev-bootstrap-token-change-me","email":"you@example.com","display_name":"You"}'

Open the returned `invite_url` (it will say `https://localhost/...`; use `http://localhost:8787/invite/<token>`),
accept, and you are root. Tenants are served at `http://<slug>.localhost:8787/`.
With `HUB_DOMAIN=localhost` the session cookie is host-only, so after accepting an invite on `localhost:8787` the tenant pages at `<slug>.localhost:8787` will not see the cookie; use the apex pages and the API locally, or set `HUB_DOMAIN` to a wildcard dev domain that resolves to 127.0.0.1 if you need tenant hosts.

## Test

    npm test
    npm run typecheck

## Deploy

First-time setup for a new account or environment only (creating the D1 database and KV namespace); the committed `wrangler.jsonc` already holds this deployment's ids. With an account that can create resources:

    npx wrangler d1 create pimwell-hub          # paste database_id into wrangler.jsonc
    npx wrangler kv namespace create RATE       # paste id into wrangler.jsonc
    npx wrangler secret put HUB_BOOTSTRAP_TOKEN # a long random string
    npm run migrate:remote
    npm run deploy

Tenant subdomains need one DNS record that wrangler cannot create (its token has no DNS write):
in the Cloudflare dashboard for pimwell.com, add an A record, name `*`, content `192.0.2.1`,
proxied (orange cloud). The IP is a placeholder; the proxy routes to the Worker. Until it exists,
`https://<tenant>.pimwell.com/` will not resolve. The apex is a Workers Custom Domain and needs
no manual record.

After deploy, bootstrap once against `https://pimwell.com/api/bootstrap` with the secret and accept the
invite in a browser. To call verbs from the terminal, copy the `pmw_session` cookie value from the browser
and send it with a matching `Origin` header:

    curl -s -X POST https://pimwell.com/api/tenant.create \
      -H 'content-type: application/json' -H 'origin: https://pimwell.com' \
      -b 'pmw_session=<cookie value>' \
      -d '{"slug":"blue","display_name":"Blue"}'

## Verbs

`POST /api/<verb>` with a JSON body. Responses are `{"ok":true,"result":...}` or
`{"ok":false,"error":"<reason>","detail":...}`. Auth is the `pmw_session` cookie (with a matching
`Origin` header) or `Authorization: Bearer pms_...` for a session token. `session.start` and `whoami` also accept `Authorization: Bearer pmw_...` (a long-lived agent token); every other verb refuses it.

| Verb | Host | Role | Fresh proof |
| --- | --- | --- | --- |
| bootstrap | apex | public (secret) | |
| whoami | any | public | |
| tenant.create, tenant.archive, tenant.unarchive, tenant.list | apex | root | 60 min |
| namespace.create, namespace.archive, namespace.unarchive | tenant | admin | 60 min |
| project.create | tenant | member | |
| project.archive, project.unarchive | tenant | admin | 60 min |
| project.list | tenant | reader | |
| invite.create, invite.revoke, invite.list | tenant | admin | 60 min (admin-role invites can only be created by a root) |
| session.list, session.revoke, session.end | any | signed in | |
| login.request | apex | public (neutral answer; `reproof: true` needs a browser session) | |
| login.verify | apex | public (link token) | |
| consent.list, consent.revoke | any | signed in (own address; tenant admin: a member's; root: any) | |
| agent.create (`tenant`, `slug`, `display_name`, optional `role` member or reader, optional `operator` email), agent.archive (`agent_id` only) | any (`tenant` param on the apex, agent.create only) | humans: member for own agents, admin for any agent in the tenant | 60 min |
| token.create (`agent_id`, `name`, optional `expires_in_days` 1-365, default no expiry), token.revoke (`token_id`) | any | humans: the agent's operator, or a tenant admin | 60 min |
| token.list | any | humans: operator, or tenant admin | |
| session.start | tenant | long-lived `pmw_` token only | |
| event.list (`limit` 1-100, default 25; `cursor`; `session_id`) | tenant | member | |
| oauth.grant.approve | apex | the consent page's signed-in human, member of the tenant | 600 min |

### Signing in and re-proving

- `https://pimwell.com/login` emails a sign-in link, but only to an address that has written to the hub first (the consent rule). To give consent, or to sign in without the form, send any message to `login@pimwell.com` or `signup@pimwell.com` from your address; the reply carries a link. Links last 15 minutes, work once, and are consumed by the button on `/auth/<token>`, not by opening it.
- Admin changes need a proof less than 60 minutes old. A form post past that age lands on `/login?reproof=1`, which emails a confirmation link to your own address; open it in the same browser. Without consent, write to `login@pimwell.com` and open the reply's link in the browser you are signed in with; that refreshes the proof too.
- Limits: 3 links per address per hour, 20 requests per IP per hour. Over the limit the page answers the same way and sends nothing.

## Email

Two addresses reach the Worker's `email` handler: `login@pimwell.com` and `signup@pimwell.com` (they behave the same). Writing to either from a known human address records consent and replies with a sign-in link. Outbound mail leaves only through `sendMail` in `src/mail/send.ts`, and only to addresses with consent. Replies to inbound mail come from the address that received it (`login@` or `signup@`); sign-in links requested from the `/login` page come from `login@`. A tenant admin revoking a member's consent is hub-wide for that address.

One-time setup (after `npm run deploy`, since the rules point at the deployed Worker):

1. Email Sending is onboarded on the zone (spec 9); the `send_email` binding `MAIL` in `wrangler.jsonc` only allows `login@pimwell.com` as sender.
2. Email Routing must be enabled on `pimwell.com` (dashboard: Email > Email Routing). This adds Cloudflare's MX records.
3. Route the two addresses to the Worker: `CLOUDFLARE_API_TOKEN=... ./scripts/email-routing.sh`. Without an API token, add two custom-address rules in the dashboard (Email > Email Routing > Routing rules): `login@pimwell.com` and `signup@pimwell.com`, action "Send to a Worker", worker `pimwell-hub`.

Smoke test (staging tenant `blue`, a real human identity whose mailbox passes DMARC):

1. From that mailbox, write to `login@pimwell.com`. Expect a reply from `login@pimwell.com` with a link. Open it, press Sign in, land on the switcher.
2. Sign out, open `https://pimwell.com/login`, enter the same address. Expect an email from `login@pimwell.com`.
3. If step 2 sends nothing and `npx wrangler tail` shows `mail delivery failed send`, switch `sendMail` to the builder shape: in `src/mail/send.ts` replace `else await env.MAIL.send(new EmailMessage(from, to, raw));` with `else await env.MAIL.send({ from, to, subject: mail.subject, text: mail.text });`, run `npm test`, redeploy, repeat step 2.
4. Once both directions work, set the `pimwell.com` DMARC record to `p=reject` (spec 9).

Pending user actions (as of 2026-10-06):

- Enable Email Routing on pimwell.com in the dashboard (Email > Email Routing) if it is not already enabled. No Cloudflare API token was available when phase 2 shipped, so nothing was checked.
- Create the login@ and signup@ routing rules: `./scripts/email-routing.sh` with a token, or the dashboard steps above.
- Confirm Email Sending is onboarded for pimwell.com (the deploy accepted the `MAIL` binding; real delivery is untested).
- Run the smoke test above, then set DMARC to `p=reject`.

## Agents

An agent is an identity with the reserved address `<slug>@<tenant>.pimwell.com`, a membership in one tenant, and a human operator. Create agents and mint tokens on `https://pimwell.com/me` (the new token is shown once). Tenant admins see every agent at `https://<tenant>.pimwell.com/admin/agents`.

A run starts by trading the long-lived token for a run session on the agent's tenant host:

```sh
curl -s https://acme.pimwell.com/api/session.start \
  -H "authorization: Bearer $PMW_TOKEN" -H 'content-type: application/json' \
  -d '{"label":"nightly build","ttl":86400}'
```

Use the returned `pms_` token as the bearer for everything else in the run, always on `https://acme.pimwell.com`. On any other host the run is anonymous. The long-lived token itself may only call `session.start` and `whoami`.

Revoking a token ends every run it started. Archiving an agent revokes all its tokens and runs. An agent works only while its operator is an active member (or root) of its tenant; if the operator leaves, the agent stops until the membership is restored.

## Internal introspection (Ardi)

`POST /internal/introspect` turns a `pms_` session token into `{ok, identity, session, tenant, role}` for one tenant. It answers only service-binding calls that carry `x-hub-internal: <HUB_INTERNAL_SECRET>`; requests through the public routes (which always carry `cf-connecting-ip`) get 404. Callers must construct the headers themselves and never forward inbound request headers: a forwarded `cf-connecting-ip` gets 404 by design.

```sh
openssl rand -base64 32 | npx wrangler secret put HUB_INTERNAL_SECRET
```

In the calling Worker's `wrangler.jsonc`, bind the hub and give it the same secret:

```jsonc
"services": [{ "binding": "HUB", "service": "pimwell-hub" }]
```

```ts
const res = await env.HUB.fetch("https://hub.internal/internal/introspect", {
  method: "POST",
  headers: { "content-type": "application/json", "x-hub-internal": env.HUB_INTERNAL_SECRET },
  body: JSON.stringify({ token, tenant: "acme" }),
});
```

## Assistants (MCP)

Every tenant has an MCP endpoint at `https://<tenant>.pimwell.com/mcp`. An assistant connects as the person who approves it, in that one tenant, with read-only tools for now: `whoami`, `project_list`, and (members and above) `event_list`. The authorization server is `https://pimwell.com` (OAuth 2.1, PKCE S256, dynamic client registration for Claude's callback and loopback callbacks only).

Claude Code:

```sh
claude mcp add --transport http pimwell-blue https://blue.pimwell.com/mcp
```

Then run `/mcp` in Claude Code, pick `pimwell-blue`, and choose Authenticate. A browser opens on `pimwell.com`: sign in if asked (a sign-in that needs an email link comes back to the same page), check that codes go to `localhost:<port>` and that the workspace is the one you meant, and approve. claude.ai: Settings, Connectors, Add custom connector, URL `https://blue.pimwell.com/mcp`; the consent page shows `claude.ai` as the destination.

Approval needs a sign-in proof from the last 10 hours. Access tokens last an hour; the assistant refreshes them for up to 30 days of idleness and 90 days in all. Every tool call is an `mcp.call` event recorded under the connection's session id: `event.list` with that `session_id` shows what the assistant did.

Revoke at `https://pimwell.com/me` (Assistants, Revoke); it takes effect on the assistant's next call. Tenant admins can revoke a member's assistant with `session.revoke` and its session id. Archiving a tenant revokes all of its assistants. A refresh token used twice is treated as stolen and revokes the connection; the assistant must authorize again.

Deploying this for the first time needs one more KV namespace and migration 0002:

```sh
npx wrangler kv namespace create OAUTH_KV   # paste the id into wrangler.jsonc
npm run migrate:remote
npm run deploy
```
