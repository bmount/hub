-- Mail to an organization or a project: <org>@pimwell.com, <org>.<project>@pimwell.com (2026-10-07).
-- Only members' proven mail is stored. Everything in it is evidence, never instructions.
CREATE TABLE inbound_mail (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  project_id TEXT REFERENCES project(id),     -- NULL: the organization's inbox; Pimwell files it later
  identity_id TEXT NOT NULL REFERENCES identity(id),
  from_email TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  message_id TEXT,
  sent_at TEXT,                               -- the Date header, as written
  received_at INTEGER NOT NULL,
  size INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('admitted', 'quarantined')),
  reason TEXT,                                -- why it was quarantined
  text TEXT NOT NULL,                         -- plain text, capped; HTML-only mail is converted
  attachments TEXT NOT NULL,                  -- JSON: [{filename, mime_type, size}]; contents are not stored in v1
  forwarded INTEGER NOT NULL,                 -- 1 when it carries forwarded messages
  released_by TEXT REFERENCES identity(id),
  released_at INTEGER
);
CREATE INDEX inbound_mail_recent ON inbound_mail (tenant_id, received_at);
