-- Agent addresses move to pimwell.com itself (owner, 2026-10-07): <agent>@<org>.<hub> becomes <org>.<agent>@<hub>.
-- No per-organization mail subdomains anywhere. Agents' names are unchanged; only their addresses move. Old-format
-- addresses are the only ones touched (local part without a dot, domain with one), so this is safe to re-run.
UPDATE identity
SET email =
  substr(email, instr(email, '@') + 1, instr(substr(email, instr(email, '@') + 1), '.') - 1)   -- org
  || '.' || substr(email, 1, instr(email, '@') - 1)                                          -- agent
  || '@' || substr(substr(email, instr(email, '@') + 1), instr(substr(email, instr(email, '@') + 1), '.') + 1)  -- hub
WHERE kind = 'agent'
  AND instr(substr(email, 1, instr(email, '@') - 1), '.') = 0
  AND instr(substr(email, instr(email, '@') + 1), '.') > 0;

-- Mail to an agent: who it was for. NULL for mail to the organization or a project.
ALTER TABLE inbound_mail ADD COLUMN recipient_id TEXT REFERENCES identity(id);
CREATE INDEX inbound_mail_recipient ON inbound_mail (recipient_id, received_at);
