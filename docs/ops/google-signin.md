# Sign in with Google: setup and lists

Design: the Google amendment at the end of `docs/superpowers/specs/2026-10-06-identity-design.md`.

## The OAuth client (once, by the account owner)

In the Google Cloud console for the project that should own the client:

1. **OAuth consent screen.** User type External (or Internal, if only one Workspace should
   ever sign in). App name Pimwell. Scopes `openid`, `email` and `profile`. These are not
   sensitive, so no Google review is needed. Publish the app so it is out of "Testing";
   otherwise only listed test users can sign in.
2. **Credentials.** Create an OAuth client ID of type Web application.
   - Authorized redirect URI: `https://pimwell.com/login/google/callback`
   - Authorized JavaScript origins: none needed.
3. **Store the values as Worker secrets** (`npm run cf` runs wrangler as pimwell-001):

       npm run cf -- secret put GOOGLE_CLIENT_ID
       npm run cf -- secret put GOOGLE_CLIENT_SECRET

Until both secrets exist, the sign-in page hides the Google button and `/login/google` answers 503.

## Sign-in rules

Rules decide who may create an account by signing in with Google. Grants decide what that account
gets. Both are rows in D1. Real addresses never go in this repository.

    -- one address
    INSERT INTO signin_rule (id, kind, value, note, created_at)
      VALUES ('<ulid>', 'email', 'person@example.com', 'why', strftime('%s','now')*1000);
    -- everyone with a Google Workspace account on a domain (checked against Google's hd claim)
    INSERT INTO signin_rule (id, kind, value, note, created_at)
      VALUES ('<ulid>', 'domain', 'example.com', 'why', strftime('%s','now')*1000);
    -- what a rule grants: one tenant, or NULL for every tenant including future ones
    INSERT INTO signin_grant (id, rule_id, tenant_id, role, created_at)
      VALUES ('<ulid>', '<rule id>', '<tenant id or NULL>', 'member', strftime('%s','now')*1000);
    -- revoke a rule (existing accounts and memberships stay; manage those separately)
    UPDATE signin_rule SET revoked_at = strftime('%s','now')*1000 WHERE id = '<rule id>';

Run statements with:

    npm run cf -- d1 execute HUB_DB --remote --command "<sql>"

Review the current lists with:

    npm run cf -- d1 execute HUB_DB --remote --command "SELECT r.kind, r.value, r.note, g.tenant_id, g.role FROM signin_rule r LEFT JOIN signin_grant g ON g.rule_id = r.id WHERE r.revoked_at IS NULL"

Every Google sign-in records a `login.google` event. Every refusal records a `login.google.refused`
event with the reason.
