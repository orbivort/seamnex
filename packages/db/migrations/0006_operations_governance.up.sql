-- 0006 — Secrets, backup/restore, audit, governance (design §7.2, fifth group).

CREATE TABLE secret (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('instance', 'idp_client', 'workflow', 'platform')),
  owner_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT secret_unique UNIQUE (scope, owner_id, name)
);

-- Envelope encryption (design §11.4): the root key never reaches this table. Each version carries
-- its wrapped DEK, the ciphertext and the AAD it was sealed with, so a swap between rows fails to
-- decrypt instead of silently returning another secret.
CREATE TABLE secret_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_id uuid NOT NULL REFERENCES secret (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  dek_id text NOT NULL,
  dek_wrapped bytea NOT NULL,
  ciphertext bytea NOT NULL,
  aad text NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  CONSTRAINT secret_version_unique UNIQUE (secret_id, version)
);

CREATE INDEX secret_version_secret_idx ON secret_version (secret_id, version DESC);

CREATE TABLE backup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('instance', 'platform')),
  instance_id uuid REFERENCES instance (id) ON DELETE SET NULL,
  render_set_id uuid REFERENCES render_set (id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'succeeded', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  object_key text,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at timestamptz,
  verify_method text,
  error_code text,
  CONSTRAINT backup_scope_shape CHECK (
    (kind = 'instance' AND instance_id IS NOT NULL)
    OR (kind = 'platform' AND instance_id IS NULL)
  )
);

CREATE INDEX backup_instance_idx ON backup (instance_id, started_at DESC);

CREATE TABLE restore_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id uuid NOT NULL REFERENCES backup (id) ON DELETE RESTRICT,
  phase text NOT NULL CHECK (
    phase IN ('preparing', 'idp', 'control_plane', 'login_verified', 'products', 'verify', 'complete', 'failed')
  ),
  concurrency integer NOT NULL DEFAULT 4 CHECK (concurrency BETWEEN 4 AND 12),
  state text NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
  justification text,
  login_verified_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX restore_run_started_idx ON restore_run (started_at DESC);

CREATE TABLE restore_drill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid REFERENCES instance (id) ON DELETE CASCADE,
  performed_at timestamptz NOT NULL DEFAULT now(),
  smoke_test text,
  passed boolean NOT NULL,
  evidence_url text
);

CREATE SEQUENCE audit_event_seq;

-- Append-only hash-chained audit log (FR-4.3, NFR-4.10). Partitioned monthly so retention is a
-- partition drop. The chain is maintained by the trigger in migration 0009 so that *any* writer
-- — including a future outbox consumer — produces a correct chain.
CREATE TABLE audit_event (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- No DEFAULT: the sequence is consumed inside the append trigger, *after* the chain lock is
  -- held. A default would assign seq before the lock, so two concurrent writers could commit in
  -- the opposite order to their sequence numbers and break the chain. The trigger overwrites any
  -- caller-supplied value, so a writer cannot choose its position in the chain either.
  seq bigint NOT NULL,
  ts timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'service', 'system')),
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  prev_hash char(64) NOT NULL,
  hash char(64) NOT NULL,
  PRIMARY KEY (seq, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX audit_event_ts_idx ON audit_event (ts DESC);
CREATE INDEX audit_event_actor_idx ON audit_event (actor_id, ts DESC);
CREATE INDEX audit_event_action_idx ON audit_event (action, ts DESC);
CREATE INDEX audit_event_request_idx ON audit_event (request_id) WHERE request_id IS NOT NULL;

-- Fourteen months forward: the NFR-4.10 floor is twelve, and the scheduler keeps the window
-- topped up. A missing partition is a failed audit append, which refuses the state change
-- (AD-20) rather than writing an unverifiable row.
DO $$
DECLARE
  month_start date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  offset_months integer;
  partition_name text;
BEGIN
  FOR offset_months IN 0..13 LOOP
    partition_name := format(
      'audit_event_p%s',
      to_char(month_start + make_interval(months => offset_months), 'YYYYMM')
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_event FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      ((month_start + make_interval(months => offset_months))::timestamp AT TIME ZONE 'UTC'),
      ((month_start + make_interval(months => offset_months + 1))::timestamp AT TIME ZONE 'UTC')
    );
  END LOOP;
END
$$;

CREATE TABLE audit_anchor (
  day date PRIMARY KEY,
  last_seq bigint NOT NULL,
  last_hash char(64) NOT NULL,
  signature text,
  stored_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE license_record (
  instance_id uuid PRIMARY KEY REFERENCES instance (id) ON DELETE CASCADE,
  license_id text NOT NULL,
  obligations jsonb NOT NULL DEFAULT '[]'::jsonb,
  resale_restricted boolean NOT NULL DEFAULT false,
  hosted_service_restricted boolean NOT NULL DEFAULT false,
  reviewed_by text,
  reviewed_at timestamptz
);

CREATE TABLE patch_record (
  instance_id uuid PRIMARY KEY REFERENCES instance (id) ON DELETE CASCADE,
  current_version text,
  latest_version text,
  oldest_unapplied_security_days integer CHECK (oldest_unapplied_security_days IS NULL OR oldest_unapplied_security_days >= 0),
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE break_glass_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester text NOT NULL,
  instance_id uuid REFERENCES instance (id) ON DELETE CASCADE,
  access_mode text NOT NULL CHECK (access_mode IN ('read_only', 'read_write')),
  state text NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'approved', 'rejected', 'active', 'expired', 'revoked')),
  justification text NOT NULL,
  approver text,
  self_approved boolean NOT NULL DEFAULT false,
  granted_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_accounts jsonb NOT NULL DEFAULT '[]'::jsonb,
  retention_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX break_glass_active_idx ON break_glass_session (state, expires_at) WHERE state = 'active';

CREATE TABLE policy_exception (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid REFERENCES deployment_plan (id) ON DELETE SET NULL,
  rule text NOT NULL,
  scope text NOT NULL,
  justification text NOT NULL,
  approver text NOT NULL,
  expires_at timestamptz NOT NULL,
  patch_diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX policy_exception_active_idx ON policy_exception (expires_at) WHERE state = 'approved';

CREATE TABLE maintenance_window (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  instance_id uuid REFERENCES instance (id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_by text NOT NULL,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_window_order CHECK (ends_at > starts_at)
);

CREATE INDEX maintenance_window_window_idx ON maintenance_window (starts_at, ends_at);

CREATE TABLE capacity_snapshot (
  ts timestamptz PRIMARY KEY,
  host jsonb NOT NULL,
  per_instance jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE drift_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  instance_id uuid REFERENCES instance (id) ON DELETE CASCADE,
  expected_hash text,
  observed_hash text,
  direction text NOT NULL CHECK (direction IN ('repo_ahead', 'runtime_ahead', 'unknown')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX drift_record_open_idx ON drift_record (detected_at DESC) WHERE resolved_at IS NULL;
