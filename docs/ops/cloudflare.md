# Cloudflare operations

Everything pimwell needs from Cloudflare, who can change it, and how it was set up.

## Credentials

| Credential | Lives in | Can do | Used by |
| --- | --- | --- | --- |
| `pimwell-001` (Cloudflare user API token, id `52f2e643…`) | macOS Keychain `pimwell-cloudflare-dev`; CI secret `CLOUDFLARE_API_TOKEN` when CI exists | Workers, routes, custom domains, D1, KV, R2, Email Routing and Sending, DNS on pimwell.com | every deploy and migration (`npm run deploy`, `npm run migrate:remote`, `npm run cf -- <wrangler args>`), deploy agents, `scripts/cf/cf.py` |
| `HUB_SECRETS_KEY` (32 random bytes, base64) | Worker secret on `pimwell-hub`; recovery copy in macOS Keychain `pimwell-hub-secrets-key` | decrypts provider keys stored in D1 (admin spec 10.2) | the hub at runtime; seeding scripts |
| personal wrangler login | `~/Library/Preferences/.wrangler` | everything the owner can do, no DNS write | nothing in pimwell since 2026-10-06 |

`pimwell-001` is the developer + deploy credential. The owner created it in the dashboard on 2026-10-06; it expires 2035-10-02. It is user-owned, so it acts as the owner within its permissions. The plaintext copy the owner handed over was moved into the Keychain and deleted.

The hub is meant to become self-modifying. When it does, the running hub should not hold `pimwell-001`: give it a separate, narrower token (deploy its own Worker only, no DNS, no D1 schema changes without review) so a compromised or misbehaving hub cannot rewrite the account. That token does not exist yet.

### Replacing or rotating `pimwell-001`

- Roll it in the dashboard (My Profile, API Tokens, the token, Roll), then store the new value:

      security add-generic-password -U -a pimwell -s pimwell-cloudflare-dev -w "$(pbpaste)"

- Or mint a fresh one from a short-lived "Create Additional Tokens" token with `python3 scripts/cf/cf.py make-deploy-token` (stores into the same Keychain item).
- `python3 scripts/cf/cf.py whoami` shows which token is in use, its status and expiry.

## Deploying

    npm run deploy                         # wrangler deploy as pimwell-001
    npm run migrate:remote                 # D1 migrations as pimwell-001
    npm run cf -- <any wrangler command>   # e.g. npm run cf -- tail

## What is configured, and where it came from

| Thing | Set up by |
| --- | --- |
| Worker `pimwell-hub`, routes `pimwell.com` (custom domain) and `*.pimwell.com/*` | `wrangler.jsonc` |
| `*.pimwell.com` proxied A record `192.0.2.1` | Added by the owner in the dashboard, 2026-10-06 (`cf.py dns-wildcard` does the same with the deploy token) |
| D1 `pimwell-hub`, KV `RATE`, KV `pimwell-oauth` | `wrangler d1 create`, `wrangler kv namespace create`; ids in `wrangler.jsonc` |
| Secrets `HUB_BOOTSTRAP_TOKEN`, `HUB_INTERNAL_SECRET` | `wrangler secret put` |
| Email Routing on, rules `login@` and `signup@` to `pimwell-hub` | `wrangler email routing enable`, `wrangler email routing rules create` (2026-10-06) |
| Rules `privacy@` and `legal@` forward to the owner's verified address (the contacts on /privacy and /terms) | Email Routing API as pimwell-001; destination verified by the owner (2026-10-06) |
| Email Sending on pimwell.com, SPF, DKIM, DMARC `p=reject` | Email Sending onboarding |
| Worker `ardi-pimwell`, R2 `ardi-pimwell-large` | Ardi repo, branch `hub-identity`, `worker/wrangler.cloudflare.jsonc` |

The account also holds unrelated projects' resources (other D1 databases, KV namespaces including one titled `OAUTH_KV`). Pimwell never touches them.
