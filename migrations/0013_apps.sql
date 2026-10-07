-- App telemetry (design 2026-10-07, approved): apps in this Cloudflare account report through the pimwell-tail
-- worker; the hub keeps what matters (errors grouped by cause, deploys, hourly counts, AI usage), redacted at the source.

-- Which app (Cloudflare script name) reports into which project. Script names are account-wide, so mapping one to an
-- organization is the account owner's decision: a registration waits for root's approval (automatic when root asks).
CREATE TABLE app_source (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  script_name TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'disabled')),
  created_by TEXT REFERENCES identity(id),
  approved_by TEXT REFERENCES identity(id),
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  last_event_at INTEGER
);

-- Requests, errors and exceptions per app per hour.
CREATE TABLE app_stat (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  script_name TEXT NOT NULL,
  hour INTEGER NOT NULL,                      -- epoch ms at the start of the hour
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,          -- outcome other than ok, or status >= 500
  exceptions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (script_name, hour)
);

-- Each new script version an app runs; the tag and message come from `wrangler deploy --tag <sha> --message <subject>`.
CREATE TABLE app_deploy (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  script_name TEXT NOT NULL,
  version_id TEXT NOT NULL,
  tag TEXT,
  message TEXT,
  seen_at INTEGER NOT NULL,
  UNIQUE (script_name, version_id)
);
CREATE INDEX app_deploy_project ON app_deploy (project_id, seen_at);

-- Errors grouped by cause: same app, same kind, same message once numbers and ids are blanked.
CREATE TABLE app_error_group (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  script_name TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('exception', 'error', 'warn', 'status')),
  title TEXT NOT NULL,
  last_message TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  first_version TEXT,
  last_version TEXT,
  work_item_id TEXT REFERENCES work_item(id)
);
CREATE INDEX app_error_group_project ON app_error_group (project_id, last_seen);

-- A few recent occurrences per group, for context (redacted path, status, Ray ID).
CREATE TABLE app_event (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  group_id TEXT NOT NULL REFERENCES app_error_group(id),
  version_id TEXT,
  at INTEGER NOT NULL,
  method TEXT,
  path TEXT,
  status INTEGER,
  ray TEXT,
  detail TEXT NOT NULL
);
CREATE INDEX app_event_group ON app_event (group_id, at);
