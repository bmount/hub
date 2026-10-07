# Cloudflare operations

Everything pimwell needs from Cloudflare, who can change it, and how it was set up.

## Credentials

| Credential | Lives in | Can do | Used by |
| --- | --- | --- | --- |
| `pimwell-deploy` API token | macOS Keychain `pimwell-cloudflare-deploy`; CI secret `CLOUDFLARE_API_TOKEN` | Workers, routes, custom domains, D1, KV, R2, Email Routing and Sending, DNS on pimwell.com only | deploys, deploy agents, `scripts/cf/cf.py` |
| bootstrap token | Keychain `pimwell-cloudflare-bootstrap`, deleted after use | create tokens | `cf.py make-deploy-token`, once |
| personal wrangler login | `~/Library/Preferences/.wrangler` | everything the owner can do, no DNS write | not used by pimwell once the deploy token exists |

The deploy token is scoped to the one account and, for DNS, to the pimwell.com zone. It expires after a year; rotate by running `make-deploy-token` again with a fresh bootstrap token.

## One-time setup (owner)

1. In the Cloudflare dashboard, open My Profile, API Tokens, Create Token, and use the template "Create Additional Tokens". Give it a short expiry (a day is plenty). Copy the value.
2. Store it in the Keychain without echoing it (copy the token to the clipboard first):

       security add-generic-password -a pimwell -s pimwell-cloudflare-bootstrap -w "$(pbpaste)"

3. Mint the deploy token and add the wildcard record:

       python3 scripts/cf/cf.py make-deploy-token
       python3 scripts/cf/cf.py dns-wildcard
       python3 scripts/cf/cf.py audit

4. Delete the bootstrap token in the dashboard and from the Keychain:

       security delete-generic-password -a pimwell -s pimwell-cloudflare-bootstrap

## Deploying as the deploy token

    scripts/cf/with-deploy-token.sh npx wrangler deploy
    scripts/cf/with-deploy-token.sh npx wrangler d1 migrations apply HUB_DB --remote

## What is configured, and where it came from

| Thing | Set up by |
| --- | --- |
| Worker `pimwell-hub`, routes `pimwell.com` (custom domain) and `*.pimwell.com/*` | `wrangler.jsonc` |
| `*.pimwell.com` proxied A record `192.0.2.1` | Added by the owner in the dashboard, 2026-10-06 (`cf.py dns-wildcard` does the same with the deploy token) |
| D1 `pimwell-hub`, KV `RATE`, KV `pimwell-oauth` | `wrangler d1 create`, `wrangler kv namespace create`; ids in `wrangler.jsonc` |
| Secrets `HUB_BOOTSTRAP_TOKEN`, `HUB_INTERNAL_SECRET` | `wrangler secret put` |
| Email Routing on, rules `login@` and `signup@` to `pimwell-hub` | `wrangler email routing enable`, `wrangler email routing rules create` (2026-10-06) |
| Email Sending on pimwell.com, SPF, DKIM, DMARC `p=reject` | Email Sending onboarding |
| Worker `ardi-pimwell`, R2 `ardi-pimwell-large` | Ardi repo, branch `hub-identity`, `worker/wrangler.cloudflare.jsonc` |

The account also holds unrelated projects' resources (other D1 databases, KV namespaces including one titled `OAUTH_KV`). Pimwell never touches them.
