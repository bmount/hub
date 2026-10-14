-- Private creation evidence survives missing/incomplete upstream metadata.
-- No foreign keys: cleanup must remain possible after project deletion.
CREATE TABLE artifact_fork_ownership (
  account TEXT NOT NULL,
  namespace TEXT NOT NULL,
  target TEXT NOT NULL,
  source TEXT NOT NULL,
  description TEXT NOT NULL,
  proof TEXT NOT NULL CHECK(proof IN ('reserved', 'accepted', 'ready', 'deleting')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account, namespace, target),
  UNIQUE(account, namespace, source, description)
);
CREATE INDEX artifact_fork_cleanup ON artifact_fork_ownership(account, created_at) WHERE proof <> 'ready';
