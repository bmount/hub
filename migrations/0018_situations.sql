-- Situations in, the truth out (roadmap milestone 7, first version): a person describes a problem; Pimwell's
-- assistant investigates read-only with the same tools; the diagnosis is kept as a record and later compared with
-- what actually happened.
CREATE TABLE situation (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  identity_id TEXT NOT NULL REFERENCES identity(id),
  thread_id TEXT NOT NULL REFERENCES assistant_thread(id),
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  report TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  outcome TEXT,                               -- what turned out to be true, filled in later
  outcome_by TEXT REFERENCES identity(id),
  outcome_at INTEGER
);
CREATE INDEX situation_tenant ON situation (tenant_id, created_at);
