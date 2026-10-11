-- The work graph (docs/ops/work-graph.md): hard dependencies between items, resources that keep conflicting work
-- from running at once, and ranking inputs. Parent/child (work_item.parent_id) and work_link stay informational.
ALTER TABLE work_item ADD COLUMN priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3);  -- 0 urgent … 3 low
ALTER TABLE work_item ADD COLUMN estimate INTEGER CHECK (estimate IS NULL OR estimate > 0);              -- hours, when known

-- prerequisite → dependent. The dependent is ready only when every prerequisite is done. Kept acyclic by
-- src/work/graphEdit.ts, which checks each edit against the whole graph before committing it.
CREATE TABLE work_dep (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  prereq_id TEXT NOT NULL REFERENCES work_item(id),
  dependent_id TEXT NOT NULL REFERENCES work_item(id),
  created_by TEXT NOT NULL REFERENCES identity(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (prereq_id, dependent_id),
  CHECK (prereq_id <> dependent_id)
);
CREATE INDEX work_dep_dependent ON work_dep (dependent_id);
CREATE INDEX work_dep_tenant ON work_dep (tenant_id);

-- Named things an item needs while under way. Two live claims conflict on a name unless both are shared.
CREATE TABLE work_resource (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  item_id TEXT NOT NULL REFERENCES work_item(id),
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('exclusive', 'shared')),
  PRIMARY KEY (item_id, name)
);
CREATE INDEX work_resource_name ON work_resource (tenant_id, name);

-- One row per committed graph edit. An edit computed against revision N inserts N + 1 in the same batch as its
-- changes, so a concurrent edit from the same revision fails the primary key and its whole batch rolls back.
CREATE TABLE work_graph_rev (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  rev INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, rev)
);
