-- Pages is a default part, including archived projects; private agent source stays unchanged.
UPDATE project SET parts = json_insert(parts, '$[#]', 'pages')
 WHERE kind IN ('repo', 'tracker', 'wiki', 'workspace')
 AND state IN ('active', 'archived')
 AND NOT EXISTS (SELECT 1 FROM json_each(parts) WHERE value = 'pages');

-- Direct inserts and createProject use the same creation templates.
DROP TRIGGER project_seed_parts;
CREATE TRIGGER project_seed_parts AFTER INSERT ON project WHEN NEW.parts = '[]' BEGIN
  UPDATE project SET parts = CASE NEW.kind
    WHEN 'repo' THEN '["docket","repo","files","pages"]'
    WHEN 'tracker' THEN '["docket","pages"]'
    WHEN 'wiki' THEN '["wiki","files","pages"]'
    WHEN 'workspace' THEN '["docket","wiki","knowledge","files","people","pages"]'
    ELSE '[]' END WHERE id = NEW.id;
END;
