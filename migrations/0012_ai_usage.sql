-- AI usage logging and accounting (owner, 2026-10-07: "ubiquitous AI usage logging and accounting").
-- model_call becomes the one ledger of AI use: Pimwell's own calls ('hub'), usage agents and people report from
-- their own tools ('reported'), and usage apps log for the telemetry worker to collect ('app').

ALTER TABLE model_call ADD COLUMN source TEXT NOT NULL DEFAULT 'hub' CHECK (source IN ('hub', 'reported', 'app'));
ALTER TABLE model_call ADD COLUMN session_id TEXT;            -- the sign-in or run it happened under
ALTER TABLE model_call ADD COLUMN project_id TEXT REFERENCES project(id);
ALTER TABLE model_call ADD COLUMN work_item_id TEXT REFERENCES work_item(id);  -- what it was for, when known
ALTER TABLE model_call ADD COLUMN client TEXT;                -- the tool that made the call: claude-code, codex, an app's name
ALTER TABLE model_call ADD COLUMN cached_tokens INTEGER;
ALTER TABLE model_call ADD COLUMN cost_micros INTEGER;        -- US dollars × 1,000,000, priced when recorded; NULL when no price is known
ALTER TABLE model_call ADD COLUMN cost_source TEXT CHECK (cost_source IN ('price', 'reported'));
CREATE INDEX model_call_tenant ON model_call (tenant_id, created_at);
CREATE INDEX model_call_identity ON model_call (identity_id, created_at);

-- Prices per million tokens, in micro-dollars, kept by root. A call is priced with the newest row in effect at the
-- time; history keeps the cost it was recorded with.
CREATE TABLE model_price (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_per_mtok INTEGER NOT NULL,
  output_per_mtok INTEGER NOT NULL,
  cached_input_per_mtok INTEGER,
  effective_from INTEGER NOT NULL,
  set_by TEXT REFERENCES identity(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX model_price_lookup ON model_price (provider, model, effective_from);
