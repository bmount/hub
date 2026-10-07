-- Model providers and credentials (admin spec section 10).
-- Keys are encrypted with AES-GCM under the Worker secret HUB_SECRETS_KEY; D1 alone never holds a usable key.
CREATE TABLE provider_credential (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenant(id),      -- NULL: the hub's own key; otherwise an organization's key
  provider TEXT NOT NULL,                    -- 'openai', later 'anthropic', 'typesafe', ...
  label TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  fingerprint TEXT NOT NULL,                 -- provider prefix and last four characters, safe to show
  status TEXT NOT NULL CHECK (status IN ('active', 'standby', 'retired')),
  verified_at INTEGER,
  verify_error TEXT,
  last_used_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER,
  created_by TEXT REFERENCES identity(id),
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);
-- At most one active key per provider per scope.
CREATE UNIQUE INDEX provider_credential_active ON provider_credential (provider, IFNULL(tenant_id, '*')) WHERE status = 'active';

-- Which model serves which purpose. Absent rows fall back to the defaults in src/models/purposes.ts.
CREATE TABLE model_route (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  tenant_id TEXT REFERENCES tenant(id),      -- NULL: hub default; otherwise an organization's override
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_by TEXT REFERENCES identity(id),
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX model_route_one ON model_route (purpose, IFNULL(tenant_id, '*'));

-- One row per model call: what answered, with which key, for whom, how it went.
CREATE TABLE model_call (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  credential_id TEXT REFERENCES provider_credential(id),
  tenant_id TEXT REFERENCES tenant(id),
  identity_id TEXT REFERENCES identity(id),
  ok INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX model_call_recent ON model_call (created_at);
