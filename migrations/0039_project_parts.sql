-- Kind is a creation template; parts are the project's live capabilities.
ALTER TABLE project ADD COLUMN parts TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(parts) AND json_type(parts) = 'array');
UPDATE project SET parts = CASE kind
  WHEN 'repo' THEN '["docket","repo","files"]'
  WHEN 'tracker' THEN '["docket"]'
  WHEN 'wiki' THEN '["wiki","files"]'
  WHEN 'workspace' THEN '["docket","wiki","knowledge","files","people"]'
  ELSE '[]' END;
UPDATE project SET parts = json_insert(parts, '$[#]', 'repo')
 WHERE EXISTS (SELECT 1 FROM repository r WHERE r.project_id = project.id AND r.tenant_id = project.tenant_id)
 AND NOT EXISTS (SELECT 1 FROM json_each(parts) WHERE value = 'repo');
CREATE TRIGGER project_seed_parts AFTER INSERT ON project WHEN NEW.parts = '[]' BEGIN
  UPDATE project SET parts = CASE NEW.kind
    WHEN 'repo' THEN '["docket","repo","files"]'
    WHEN 'tracker' THEN '["docket"]'
    WHEN 'wiki' THEN '["wiki","files"]'
    WHEN 'workspace' THEN '["docket","wiki","knowledge","files","people"]'
    ELSE '[]' END WHERE id = NEW.id;
END;
CREATE TRIGGER repository_enable_part AFTER INSERT ON repository BEGIN
  UPDATE project SET parts = json_insert(parts, '$[#]', 'repo')
    WHERE id = NEW.project_id AND tenant_id = NEW.tenant_id
    AND NOT EXISTS (SELECT 1 FROM json_each(parts) WHERE value = 'repo');
END;
