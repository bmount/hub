CREATE TABLE perf_budget_check (
  site_id TEXT NOT NULL REFERENCES site(id),
  script_name TEXT NOT NULL,
  deploy_id TEXT NOT NULL REFERENCES app_deploy(id),
  checked_at INTEGER NOT NULL,
  met INTEGER NOT NULL,
  measured INTEGER NOT NULL,
  PRIMARY KEY (site_id, script_name)
);
CREATE TABLE perf_alert (
  site_id TEXT NOT NULL REFERENCES site(id),
  script_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  budget TEXT NOT NULL,
  route TEXT NOT NULL,
  situation_id TEXT NOT NULL REFERENCES situation(id),
  deploy_id TEXT NOT NULL REFERENCES app_deploy(id),
  commit_oid TEXT,
  span TEXT,
  PRIMARY KEY (site_id, script_name, kind, budget, route)
);
