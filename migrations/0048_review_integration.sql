-- Legacy reviews did not record the base tip; never guess what was reviewed.
ALTER TABLE review ADD COLUMN base_oid TEXT;
ALTER TABLE review ADD COLUMN merge_push_id TEXT;
ALTER TABLE review ADD COLUMN merged_oid TEXT;
CREATE INDEX review_integrating ON review(project_id, repo) WHERE merge_push_id IS NOT NULL;
