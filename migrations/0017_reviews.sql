-- Reviews (2026-10-07): ask people or agents to review a branch; comments by file and line; verdicts per reviewer.
-- Integrating an approved review waits for a merge verb in Ardi (docs/requests/2026-10-07-ardi-source-tracking.md).
CREATE TABLE review (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  number INTEGER NOT NULL,
  branch TEXT NOT NULL,
  base TEXT NOT NULL,
  head_oid TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'changes', 'closed')),
  author_id TEXT NOT NULL REFERENCES identity(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, number)
);
CREATE INDEX review_tenant ON review (tenant_id, status, updated_at);

CREATE TABLE review_reviewer (
  review_id TEXT NOT NULL REFERENCES review(id),
  identity_id TEXT NOT NULL REFERENCES identity(id),
  verdict TEXT CHECK (verdict IN ('approve', 'changes')),
  reason TEXT,
  head_oid TEXT,                              -- the commit the verdict was given on
  at INTEGER,
  PRIMARY KEY (review_id, identity_id)
);

CREATE TABLE review_comment (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES review(id),
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  author_id TEXT NOT NULL REFERENCES identity(id),
  path TEXT,
  line INTEGER,
  head_oid TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX review_comment_review ON review_comment (review_id, created_at);

-- Attention entries that point somewhere other than a work item (a review).
ALTER TABLE attention ADD COLUMN href TEXT;
