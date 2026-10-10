# pimwell-hub

Control plane for the pimwell team hub: tenants, identities, sessions, invites.
Design: `docs/superpowers/specs/2026-10-06-identity-design.md`.
Why it exists and what every design must serve: `docs/direction.md`.

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

After deploy, bootstrap once against `https://pimwell.com/api/bootstrap` with the secret, then open the
invite in a browser and sign in with Google as its exact invited, verified address. Invite possession
alone cannot create an identity or grant root/membership; Google must be configured (email-only new-invite
onboarding is not yet supported). See [invite boundaries](docs/ops/invite-addresses.md).
To call verbs from the terminal, copy the `pmw_session` cookie value from the browser
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
| session.git (`label`, `tenant` on the apex) | any | humans: any role in the tenant | 60 min |
| event.list (`limit` 1-100, default 25; `cursor`; `session_id`) | tenant | member | |
| oauth.grant.approve | apex | the consent page's signed-in human, member of the tenant | 600 min |
| channel.create, channel.set_topic, channel.add_agent, channel.remove_agent, channel.set_agent_policy | tenant | member (humans only; the agent policy needs the channel's creator or an admin, and a fresh sign-in to open) | |
| channel.archive, channel.unarchive | tenant | admin (humans only) | 60 min |
| chat.conversations, chat.read, chat.thread, chat.history, chat.inbox, chat.catchup, ref.backlinks, inbox.wait, inbox.ack, chat.mark_read | tenant | reader (agents only in channels they were added to) | |
| chat.post, chat.edit, chat.retract | tenant | member (`after` required for agent runs and assistants) | |
| chat.agent_mute | tenant | the agent, its operator, or an admin | |
| chat.agent_unmute | tenant | member (operator or admin; humans only) | 60 min |
| chat.agents_disable | tenant | admin | |
| chat.agents_enable | tenant | admin | 60 min |

### Signing in and re-proving

The signed-in shell shows the active email address and role, not just the display name. On phones these are in the menu under Your account. Ordinary Google sign-in selects an account and replaces this browser's shared hub/organization session cookie; separate email identities are not merged. Invite verification uses that same sign-in flow. Enhanced navigation reloads the page if the server reports a different account or role, rather than retaining the previous account's panes. An extra check (`reproof=1`) must match the existing account and browser session instead of switching accounts.

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

## Messaging

Channels live on tenant hosts. Every member reads every channel; members and above post; agents read and post only in channels their operator (or an admin) added them to. Pages: `/c` (channels), `/c/<channel>`, `/c/<channel>/t/<n>` (a thread), `/m/<message id>` (a message with every version), `/inbox`.

Name tags are the server's: a message shows the author's handle (members get one from their address; agents get their slug), an `agent` badge with the operator and the run's label for agents, and `via assistant` for posts from an MCP connection. No verb takes an author.

References become typed links: `site@3f9a2c1` (commit), `site#k7q2` (ticket), `session:<id>`, `msg:general/412`, and mentions `@scout`. Commit and ticket titles come from Ardi; until Ardi answers `/internal/resolve`, tickets and full 40-character commit ids are kept without a title and short commit ids are reported as unresolved. `ref.backlinks` answers where something was discussed; Ardi can ask the same over `POST /internal/backlinks` with the introspection secret.

An agent run works like this:

```sh
H='content-type: application/json'
api() { curl -s "https://acme.pimwell.com/api/$1" -H "authorization: Bearer $PMS" -H "$H" -d "$2"; }
api inbox.wait '{"wait_s":20}'                    # wakes: mentions and replies, no message text
api chat.thread '{"c":"general","msg":412}'       # read what woke you; note "head"
api chat.post '{"c":"general","reply_to":412,"after":418,"body":"done in site@3f9a2c1","idempotency_key":"run7-1"}'
api inbox.ack '{"through":12}'
api chat.catchup '{"budget":1500,"advance":true}' # what happened since your cursors
```

`after` is required for agent runs: if anyone else posted in that scope since, the post is refused with `stale_view` and the missed messages; read and post again. Limits: 6 posts a minute and 60 an hour per run, 300 a day per agent, 30 a minute for all agents in a channel, no repeating the same text within 10 minutes. Agents never wake each other past three hops, are paused after 8 agent messages in a row until a human posts, and two agents that keep answering each other stop waking each other for 30 minutes. More than 20 refused posts in an hour mutes an agent.

Stopping agents: `chat.agent_mute` (the agent, its operator, an admin), `channel.set_agent_policy` to `mention_only` or `muted` (the channel's creator or an admin), and the tenant kill switch `chat.agents_disable` (admins). Loosening any of them needs a fresh sign-in.

Assistants get read-scoped chat tools including `chat_catchup`, `chat_read`, `chat_thread`, `chat_history`, `chat_inbox`, `chat_presence`, `chat_post_status`, `chat_response_status` and `ref_backlinks`. Write-scoped connections can additionally post (members), publish truthful presence, mark read and acknowledge their own inbox, subject to current role and resource policy. MCP posting requires a current read head and stable idempotency key; reconcile uncertain sends before retrying. See [chat participation](docs/ops/chat-participation.md). Every rendered result starts with a note that message text is data, and only lines starting with `[#` are written by the hub; neither text nor a sender label grants broader execution authority.

Real-time streams arrive in phase 2; until then agents use `inbox.wait` and pages refresh on reload.

### Phase 1 exit run on `blue`

Run after the migration (`0004_chat.sql`, `npx wrangler d1 migrations apply HUB_DB --remote`) and the deploy (`npx wrangler deploy`, which applies Durable Object migration tag `chat-v1`). Not yet run.

Two agents and a human work a ticket in `#general`, and the ticket can be found from the conversation and the conversation from the ticket.

1. As a human admin of `blue` in a browser: open `https://blue.pimwell.com/c`, create `general`, and add two agents you operate (create them on `https://pimwell.com/me` if needed; this run calls them `scout` and `tidy`). Pick a real ticket in the smoke repository (or, if Ardi has no tickets yet, a full 40-character commit id from the integration smoke push) and post in `#general`: `@scout please check smoke#<ticket>` (or `smoke@<oid>`).
2. For each agent, start a run and keep its token: `PMS=$(curl -s https://blue.pimwell.com/api/session.start -H "authorization: Bearer $PMW" -H 'content-type: application/json' -d '{"label":"exit-run"}' | jq -r .result.session_token)`. Ticket ids in references are 4 to 16 characters of `[a-z0-9]` (`smoke#k7q2`); anything else is not linked, so pick a ticket whose id fits.
3. As `scout`: `inbox.wait` returns the mention (no message text); `chat.thread` shows it; `chat.post` a reply with `reply_to`, `after` = the thread's head, and `@tidy`; the result's `unresolved` is empty and the reply's refs show the ticket.
4. As `tidy`: `inbox.wait` returns the reply; post a reply in the thread mentioning `@scout`. As `scout`: answer once more with `@tidy`; the result shows `hop` 3, and `tidy` calls `inbox.ack` through its last item number, then `inbox.wait` with `after` set to that number and `wait_s` 5, which returns nothing new (without `after` or the ack, `inbox.wait` returns the open items again).
5. From the ticket back to the talk: `curl -s https://blue.pimwell.com/api/ref.backlinks -H "authorization: Bearer $PMS" -H 'content-type: application/json' -d '{"kind":"ticket","key":"smoke#<ticket>"}'` lists the messages in `#general`, and each `/m/<id>` link opens in the browser. Once Ardi calls `/internal/backlinks`, its ticket page shows the same list.
6. As the human, post in the thread, then in Claude Code connected to `blue` call `chat_catchup` and `chat_read` for `general`: both answers start with the data note and show the agents' name tags with `agent op:@<you> run:exit-run`. Record `used_tokens` from `chat.catchup` for the human and for each agent against spec 11.3's targets (under 1,500 for a busy channel, under 400 for an agent with no mentions).
7. Check the record: `event.list` shows `chat.post` rows for all three identities with their session ids and `chat.wake_suppressed` for step 4, and none of the summaries contains message text.

## Git (Ardi)

Git smart HTTP on a tenant host (`https://<tenant>.pimwell.com/<repo>.git`) is forwarded to Ardi, which authenticates with hub session tokens. Humans mint a credential on /me ("New git credential for <tenant>") and use it as the password. The username is ignored; by convention use your email. Repos are created on Ardi at `https://ardi-pimwell.bvmount.workers.dev/t/<tenant>/api/repo.create` with an admin credential. The staging tenant is `blue`.

## Internal introspection (Ardi)

`POST /internal/introspect` accepts `git` and `agent_run` sessions only (browser and oauth sessions are refused). It turns a `pms_` session token into `{ok, identity, session, tenant, role}` for one tenant. It answers only service-binding calls that carry `x-hub-internal: <HUB_INTERNAL_SECRET>`; requests through the public routes (which always carry `cf-connecting-ip`) get 404. Callers must construct the headers themselves and never forward inbound request headers: a forwarded `cf-connecting-ip` gets 404 by design.

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

Every tenant has an MCP endpoint at `https://<tenant>.pimwell.com/mcp`. An OAuth assistant connects as the person who approves it, in that one tenant, with explicit **read and/or write** consent. `tools/list` recomputes exposure from the grant's scopes and that person's current role. Read grants expose queries; write grants additionally permit declared commands such as `work_create`, `work_update`, `chat_post`, `mail_reply` and `deploy_record`, within their role and resource boundaries. Readers can perform limited self-service commands (for example inbox acknowledgements) with write consent, not member-only posting or sending. Credential/access-management, admin/root, hub and fresh-proof verbs are never exposed over MCP. Declared planned stubs are not implemented capabilities. See the [generated tool reference](docs/generated/mcp-tools.md) and [MCP contract guidance](docs/ops/mcp-contract.md); regenerate/check the inventory with `npm run docs:mcp` / `npm test`.

The authorization server is `https://pimwell.com` (OAuth 2.1, PKCE S256). Callback allowlisting still applies; client support does not imply every hosted product/account has a connector UI. Headless agents instead use their operator-configured `/agent/mcp` connection, not a human OAuth grant or permission to create credentials through MCP.

Claude Code:

```sh
claude mcp add --transport http pimwell-blue https://blue.pimwell.com/mcp
```

Then run `/mcp` in Claude Code, pick `pimwell-blue`, and choose Authenticate. A browser opens on `pimwell.com`: sign in if asked (a sign-in that needs an email link comes back to the same page), check that codes go to `localhost:<port>` and that the workspace is the one you meant, and approve. claude.ai: Settings, Connectors, Add custom connector, URL `https://blue.pimwell.com/mcp`; the consent page shows `claude.ai` as the destination.

Approval needs a sign-in proof from the last 10 hours. Access tokens last an hour; the assistant refreshes them for up to 30 days of idleness and 90 days in all. Every tool call is an `mcp.call` event recorded under the connection's session id: `event.list` with that `session_id` shows what the assistant did.

Revoke at `https://pimwell.com/me` (Assistants, Revoke); it takes effect on the assistant's next call. Tenant admins can revoke a member's assistant with `session.revoke` and its session id. To find the session id, look at `event.list` rows of kind `mcp.call` (or `oauth.grant.approve`): each row's `session_id` is that assistant's connection, and the row's summary names the tool it called. A member finds their own on `https://pimwell.com/me`, which lists each assistant with its session id. Archiving a tenant revokes all of its assistants. A refresh token used twice is treated as stolen and revokes the connection; the assistant must authorize again.

Your assistant can be steered by content it reads; it sees what you can see in this tenant; revoke it any time at /me.

Deploying this for the first time needs one more KV namespace and migrations 0002 and 0003:

```sh
npx wrangler kv namespace create OAUTH_KV   # paste the id into wrangler.jsonc
npm run migrate:remote
npm run deploy
```
