ALTER TABLE inbound_mail ADD COLUMN reason_code TEXT;
ALTER TABLE inbound_mail ADD COLUMN auth_results TEXT;
UPDATE inbound_mail SET reason_code = 'auth_unknown', auth_results = '{"availability":"not_retained","note":"Original authentication results were not retained before this change"}' WHERE verdict = 'quarantined';
