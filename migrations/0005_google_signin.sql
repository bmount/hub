-- Sign in with Google (identity spec, amendment 2026-10-06).
-- Who may create an account by signing in with Google is a short, root-managed list of rules.
-- Each rule matches one verified email address, or one Google Workspace domain (the token's `hd` claim).
CREATE TABLE signin_rule (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'domain')),
  value TEXT NOT NULL,              -- lowercased email address or domain
  note TEXT,
  created_by TEXT REFERENCES identity(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (kind, value)
);

-- What a matching rule grants at each sign-in. A NULL tenant means every active tenant, including
-- tenants created later. Grants add or raise a membership; they never lower or revive a removed one.
CREATE TABLE signin_grant (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES signin_rule(id),
  tenant_id TEXT REFERENCES tenant(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'reader')),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX signin_grant_one ON signin_grant (rule_id, IFNULL(tenant_id, '*'));

-- The Google account (`sub`) first used for an identity. A later sign-in for the same email from a
-- different Google account is refused: an address can be recycled, the account id cannot.
CREATE TABLE google_account (
  sub TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL UNIQUE REFERENCES identity(id),
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
