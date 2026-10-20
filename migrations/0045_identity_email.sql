-- Additional addresses belong to a global human identity, never to a tenant.
CREATE TABLE identity_email (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  identity_id TEXT NOT NULL REFERENCES identity(id),
  confirmed_at INTEGER NOT NULL,
  confirmed_by TEXT NOT NULL REFERENCES identity(id)
);
CREATE INDEX identity_email_identity ON identity_email(identity_id);
-- Enforce uniqueness across primary and linked addresses, including future signups.
CREATE TRIGGER identity_email_no_primary BEFORE INSERT ON identity_email
WHEN EXISTS (SELECT 1 FROM identity WHERE email = NEW.email COLLATE NOCASE)
BEGIN SELECT RAISE(ABORT, 'email exists'); END;
CREATE TRIGGER identity_no_linked_email BEFORE INSERT ON identity
WHEN EXISTS (SELECT 1 FROM identity_email WHERE email = NEW.email COLLATE NOCASE)
BEGIN SELECT RAISE(ABORT, 'email exists'); END;
CREATE TRIGGER identity_update_no_linked_email BEFORE UPDATE OF email ON identity
WHEN EXISTS (SELECT 1 FROM identity_email WHERE email = NEW.email COLLATE NOCASE)
BEGIN SELECT RAISE(ABORT, 'email exists'); END;
