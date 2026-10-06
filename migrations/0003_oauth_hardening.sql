-- MCP phase 1 final fix wave: the retired refresh hash per grant (reuse detection that a forged token cannot trigger)
-- and an atomic counter table for the per-grant and per-IP MCP rate limits.
ALTER TABLE oauth_grant ADD COLUMN prev_refresh_hash TEXT;
-- sha256 of the authorization code the grant was approved with: only that exact code coming back is replay.
ALTER TABLE oauth_grant ADD COLUMN code_hash TEXT;

CREATE TABLE rate_counter (
  "key" TEXT NOT NULL,
  "window" INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY ("key", "window")
);
CREATE INDEX rate_counter_expires ON rate_counter (expires_at);

UPDATE meta SET value = '3' WHERE key = 'schema_version';
