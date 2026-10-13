-- Orphan cleanup must check every surviving version without a full metadata scan.
CREATE INDEX file_revision_object_key ON file_revision(object_key);
