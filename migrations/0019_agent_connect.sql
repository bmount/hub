-- Headless agents (owner, 2026-10-08): a person creates an agent in Pimwell and gets a one-time connect link, valid
-- 24 hours, to paste to the agent. The agent claims it with a POST and receives its own long-lived token for
-- /agent/mcp. Only the link's hash is kept; a claim is one atomic update, so a link works once.
CREATE TABLE agent_connect_link (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  agent_id TEXT NOT NULL REFERENCES identity(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES identity(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  claimed_ip TEXT,
  api_token_id TEXT REFERENCES api_token(id)
);
CREATE INDEX agent_connect_link_agent ON agent_connect_link (agent_id);

-- The run session an agent's /agent/mcp calls work under: one at a time per long-lived token, reused until close to
-- expiry. Its token is sealed (HUB_SECRETS_KEY) so the hub can read code from the git host as the agent.
CREATE TABLE agent_mcp_session (
  session_id TEXT PRIMARY KEY REFERENCES session(id),
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  api_token_id TEXT NOT NULL REFERENCES api_token(id),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL
);
CREATE INDEX agent_mcp_session_token ON agent_mcp_session (api_token_id);
