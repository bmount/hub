-- Work items: wishes, snags, errands, quests, calls, sparks (overnight plan task 2; roadmap milestone 2).
CREATE TABLE work_item (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  number INTEGER NOT NULL,                    -- per project, for short references like pricebench#12
  kind TEXT NOT NULL CHECK (kind IN ('wish', 'snag', 'errand', 'quest', 'call', 'spark')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'doing', 'done', 'dropped')),
  owner_id TEXT REFERENCES identity(id),      -- a person or a helper
  lease_until INTEGER,                        -- a claim lasts until then unless renewed
  parent_id TEXT REFERENCES work_item(id),    -- the quest it belongs to
  source_kind TEXT,                           -- where it came from: mail, message, event, owner, url
  source_ref TEXT,
  source_quote TEXT,                          -- the words it came from, briefly
  source_at INTEGER,                          -- when those words were written
  created_by TEXT NOT NULL REFERENCES identity(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE UNIQUE INDEX work_item_number ON work_item (project_id, number);
CREATE INDEX work_item_docket ON work_item (project_id, state, updated_at);
CREATE INDEX work_item_owner ON work_item (owner_id, state);

-- What a work item is linked to: commits, mail, messages, events, other items, or a URL.
CREATE TABLE work_link (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('commit', 'mail', 'message', 'event', 'item', 'url')),
  target_ref TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL REFERENCES identity(id),
  created_at INTEGER NOT NULL,
  UNIQUE (item_id, target_kind, target_ref)
);
