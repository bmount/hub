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

## Test

    npm test
    npm run typecheck

## Deploy

One-time, with an account that can create resources:

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
| invite.create, invite.revoke, invite.list | tenant | admin | 60 min |
| session.list, session.revoke, session.end | any | signed in | |

Phase 1 has no re-proof flow; a session older than 60 minutes cannot run the fresh-proof verbs
until phase 2 adds magic links. Accept a new invite to get a fresh session in the meantime.
