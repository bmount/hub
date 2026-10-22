-- ChatGPT connects to MCP servers through this stable OAuth callback (it uses it because the hub
-- sends iss on every authorization response, RFC 9207). Without it, ChatGPT's client registration is refused.
INSERT OR IGNORE INTO oauth_redirect_allow (id, pattern, label, created_by, created_at) VALUES
  ('seed-chatgpt', 'https://chatgpt.com/connector_platform_oauth_redirect', 'ChatGPT', NULL, 0);
