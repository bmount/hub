-- Extend group kinds additively without rebuilding the table or its event references.
ALTER TABLE app_error_group ADD COLUMN client_kind TEXT CHECK (client_kind IS NULL OR client_kind = 'slow');
