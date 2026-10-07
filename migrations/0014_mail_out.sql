-- Outbound mail from organizations, projects and agents (design 2026-10-07, B3; owner: 30-day window).
-- Off until an admin turns it on for the organization. Every message sent is kept in full, on the record.
ALTER TABLE tenant ADD COLUMN mail_out INTEGER NOT NULL DEFAULT 0;

CREATE TABLE outbound_mail (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  in_reply_to TEXT REFERENCES inbound_mail(id),   -- the message it answers, when it is a reply
  sent_by TEXT NOT NULL REFERENCES identity(id),
  session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'refused')),
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX outbound_mail_sender ON outbound_mail (sent_by, created_at);
CREATE INDEX outbound_mail_tenant ON outbound_mail (tenant_id, created_at);
CREATE INDEX outbound_mail_reply ON outbound_mail (in_reply_to);
