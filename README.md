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
`Origin` header) or `Authorization: Bearer pms_...` for a session token.

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
