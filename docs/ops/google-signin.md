# Sign in with Google: setup and lists

Design: the Google amendment at the end of `docs/superpowers/specs/2026-10-06-identity-design.md`.

## Google setup (once, by the account owner)

Everything is at https://console.cloud.google.com/auth (Google Auth Platform). It works from a phone.

1. **Project.** Pick or create a project at the top, for example "Pimwell". If asked to "Get started":
   - App name **Pimwell**, support email yours.
   - Audience **External**. Gmail addresses are on the list, so Internal would lock them out.
   - Contact email yours. Agree and press **Create**.
2. **Branding** (left menu):
   - Authorized domains: `pimwell.com`.
   - Privacy policy: `https://pimwell.com/privacy`. Terms of service: `https://pimwell.com/terms`.
   - Upload no logo. A logo triggers a slow brand verification.
   - **Save**.
3. **Data Access** (left menu): this is where the scopes go.
   - Press **Add or remove scopes**.
   - Tick `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`.
   - Press **Update**, then **Save**.
4. **Audience** (left menu): press **Publish app** and confirm. In "Testing" mode only listed test users can sign in.
5. **Clients** (left menu): press **Create client**, then fill in:
   - Application type **Web application**, name `pimwell-hub`.
   - Authorized JavaScript origins: `https://pimwell.com`.
   - Authorized redirect URIs: `https://pimwell.com/login/google/callback`. Exact, with no trailing slash.
   - Press **Create**.
6. **Copy the ID and secret.** The dialog that opens shows:
   - **Client ID**, ending in `.apps.googleusercontent.com`
   - **Client secret**, starting with `GOCSPX-`

   Copy both, or press **Download JSON**. The full secret is shown only now. The client ID stays visible under **Clients**. If you lose the secret, open the client and choose **Add secret**.
7. **Give them to Pimwell.** Either way, future deploys keep them.
   - **Web:** in https://dash.cloudflare.com go to **Workers & Pages**, then **pimwell-hub**, **Settings**, **Variables and Secrets**, **Add**. Choose type **Secret** and add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
   - **Terminal:** run these and paste each value when asked.

         npm run cf -- secret put GOOGLE_CLIENT_ID
         npm run cf -- secret put GOOGLE_CLIENT_SECRET
8. **Test.** Open https://pimwell.com/login and press **Sign in with Google**.
   - The owner's company account becomes root by accepting the pending root invite.
   - An address that isn't on the list gets a polite refusal.

Until both secrets exist, the Google button is hidden and `/login/google` answers 503.

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
