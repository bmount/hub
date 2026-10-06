export type State = "active" | "archived";
export type Role = "root" | "admin" | "member" | "reader";
export type IdentityKind = "human" | "agent";

export type Tenant = { id: string; slug: string; display_name: string; state: State; created_at: number };
export type Namespace = { id: string; tenant_id: string; slug: string; display_name: string; state: State; created_at: number };
export type Project = {
  id: string; tenant_id: string; namespace_id: string | null; slug: string; kind: string;
  display_name: string; state: State; created_at: number;
};
export type Identity = {
  id: string; kind: IdentityKind; display_name: string; is_root: number; email: string;
  operator_id: string | null; state: State; created_at: number;
};
export type Membership = { id: string; identity_id: string; tenant_id: string; role: Role; state: State; created_at: number };
export type Invite = {
  id: string; tenant_id: string | null; email: string; role: Role; display_name: string | null;
  token_hash: string; created_by: string | null; created_at: number; expires_at: number;
  accepted_at: number | null; accepted_session_id: string | null; revoked_at: number | null;
};
export type Session = {
  id: string; identity_id: string; tenant_id: string | null; kind: "browser" | "agent_run" | "oauth"; label: string | null;
  token_hash: string; created_at: number; last_seen_at: number; expires_at: number; last_proof_at: number;
  revoked_at: number | null; parent_token_id: string | null;
};
export type EventRow = {
  id: string; tenant_id: string | null; identity_id: string | null; session_id: string | null;
  kind: string; target_kind: string; target_id: string; summary: string; created_at: number;
};

export type LinkPurpose = "login" | "reproof";
export type AuthLink = {
  id: string; identity_id: string; token_hash: string; purpose: LinkPurpose;
  created_at: number; expires_at: number; used_at: number | null;
};
export type Consent = {
  id: string; email: string; tenant_id: string | null; kind: string; granted_at: number;
  revoked_at: number | null; source_message_id: string | null; evidence: string | null;
};
export type ProofKind = "email" | "google" | "passkey";
export type Proof = { id: string; identity_id: string; kind: ProofKind; subject: string; created_at: number };

export type ApiToken = {
  id: string; identity_id: string; tenant_id: string; name: string; token_hash: string; scopes: string;
  created_by: string; created_at: number; expires_at: number | null; last_used_at: number | null; revoked_at: number | null;
};
export type Agent = { identity: Identity; membership: Membership; tenant: Tenant; slug: string };

export type OAuthGrant = {
  id: string; identity_id: string; tenant_id: string; session_id: string; client_id: string; client_name: string;
  client_kind: "dcr" | "cimd"; redirect_host: string; resource: string; scopes: string; library_grant_id: string | null;
  refresh_hash: string | null; prev_refresh_hash: string | null; code_hash: string | null; refreshed_at: number | null; approved_by_session_id: string; created_at: number; expires_at: number;
  revoked_at: number | null; revoked_by: string | null; revoke_reason: string | null;
};
