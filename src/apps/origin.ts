// Correlation is evidence, not proof that the deploy caused the error. Exact version only:
// never guess a commit from the nearest unrelated deployment or another tenant's record.
export function errorOriginColumns(): string {
  const match = `d.tenant_id = g.tenant_id AND d.project_id = g.project_id AND d.script_name = g.script_name
    AND (d.version_id = g.first_version OR substr(d.version_id, 1, 36) = g.first_version)
    AND d.seen_at <= g.first_seen`;
  const order = `ORDER BY CASE WHEN length(d.version_id) = 73 THEN 0 ELSE 1 END, d.seen_at DESC, d.id DESC LIMIT 1`;
  return `g.first_version,
    (SELECT d.id FROM app_deploy d WHERE ${match} ${order}) AS first_deploy,
    (SELECT CASE WHEN length(d.tag) = 40 AND d.tag NOT GLOB '*[^0-9a-f]*' THEN d.tag ELSE NULL END
      FROM app_deploy d WHERE ${match} ${order}) AS first_commit`;
}
