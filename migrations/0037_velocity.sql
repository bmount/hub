ALTER TABLE project ADD COLUMN velocity_since INTEGER;
UPDATE project SET velocity_since = 1791609960000 WHERE slug = 'pimwell' AND namespace_id IS NULL AND tenant_id IN (SELECT id FROM tenant WHERE slug = 'mcc');
UPDATE project SET velocity_since = 1791528660000 WHERE slug = 'agentfeed' AND namespace_id IS NULL AND tenant_id IN (SELECT id FROM tenant WHERE slug = 'mcc');
CREATE INDEX event_work_history ON event(tenant_id, target_kind, target_id, created_at);
CREATE INDEX model_call_work_usage ON model_call(tenant_id, project_id, work_item_id, created_at);
