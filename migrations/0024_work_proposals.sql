-- Proposed changes to the work graph (docs/ops/work-graph.md): new items and dependency changes an agent or person
-- discovered, applied only when another member approves. The proposal never touches the live graph by itself.
CREATE TABLE work_proposal (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  item_id TEXT REFERENCES work_item(id),       -- the item the proposer was working on, if any
  reason TEXT NOT NULL,
  change_json TEXT NOT NULL,                    -- {new_items: [...], add: [...], remove: [...]}, see src/work/proposals.ts
  created_by TEXT NOT NULL REFERENCES identity(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX work_proposal_tenant ON work_proposal (tenant_id, created_at);

-- One decision per proposal: a second reviewer's decision fails the primary key and its batch rolls back.
CREATE TABLE work_proposal_decision (
  proposal_id TEXT PRIMARY KEY REFERENCES work_proposal(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note TEXT,
  result_json TEXT,                             -- what approval created: {items: [{key, id}]}
  decided_by TEXT NOT NULL REFERENCES identity(id),
  decided_at INTEGER NOT NULL
);
