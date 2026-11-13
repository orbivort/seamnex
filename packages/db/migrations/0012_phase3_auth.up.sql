-- 0012 — Phase 3 authentication and authorization (plan §5.3).
--
-- Sessions live in Redis by design, so this migration adds only what must be durable:
--   * the identity mirror columns the sync worker now writes (display name, MFA enrolment,
--     last login, job title) and the group member count (the platform has no membership table);
--   * the machine-client credential (hash only — a database read must not yield a token);
--   * the policy source hash, so an unchanged matrix is not re-versioned on every boot.

ALTER TABLE idp_user ADD COLUMN display_name text;
ALTER TABLE idp_user ADD COLUMN job_title text;
ALTER TABLE idp_user ADD COLUMN mfa_enrolled boolean NOT NULL DEFAULT false;
ALTER TABLE idp_user ADD COLUMN last_login_at timestamptz;

ALTER TABLE idp_group ADD COLUMN member_count integer NOT NULL DEFAULT 0
  CHECK (member_count >= 0);

-- ADR-BE-05: the compiled snapshot is versioned by the hash of its source. A null hash keeps any
-- pre-Phase-3 row (there is at most the Phase 1 bootstrap row) out of the unique index.
ALTER TABLE policy_version ADD COLUMN source_hash text;

CREATE UNIQUE INDEX policy_version_source_hash
  ON policy_version (source_hash)
  WHERE source_hash IS NOT NULL;

-- Deliverable 3.4: machine clients hold a closed scope, never a human role. Only the SHA-256 hash
-- of the bearer token is stored; the token is printed once at provisioning time.
CREATE TABLE machine_client (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  token_hash text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('registry.read', 'audit.read')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT machine_client_name_unique UNIQUE (name),
  CONSTRAINT machine_client_token_unique UNIQUE (token_hash)
);

COMMENT ON TABLE machine_client IS
  'Bearer credentials for machine consumers; stores only a token hash (Phase 3, deliverable 3.4).';
