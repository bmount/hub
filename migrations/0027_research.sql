-- Research is a typed wiki revision, not a separate document store.
ALTER TABLE wiki_revision ADD COLUMN research TEXT;
