-- Source-only aliases are deployment-managed, never agent-editable identity names.
CREATE TABLE agent_source_alias (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  alias TEXT NOT NULL CHECK (alias = lower(alias)),
  identity_id TEXT NOT NULL REFERENCES identity(id),
  PRIMARY KEY (tenant_id, alias)
);

-- Operator-approved short source URL for Shannon Nook; pin the identity, not its mutable address.
INSERT INTO agent_source_alias (tenant_id, alias, identity_id)
SELECT m.tenant_id, 'shannon', i.id FROM identity i
JOIN membership m ON m.identity_id = i.id JOIN tenant t ON t.id = m.tenant_id
WHERE t.slug = 'mcc' AND i.id = '01M4VG30DKRYJNM1JSG4YM5K7J'
  AND i.email = 'mcc.shannon-nook@pimwell.com' AND i.kind = 'agent'
  AND NOT EXISTS (SELECT 1 FROM identity other JOIN membership om ON om.identity_id = other.id
    WHERE om.tenant_id = m.tenant_id AND other.email = 'mcc.shannon@pimwell.com');
