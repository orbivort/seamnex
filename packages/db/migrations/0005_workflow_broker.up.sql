-- 0005 — Workflow authoring and the credential broker (design §7.2, fourth group).

CREATE TABLE workflow (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text,
  owner_idp_id text NOT NULL,
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'validated', 'active', 'disabled', 'failed')),
  -- FK to workflow_version is added in migration 0009 (cyclic dependency).
  current_version_id uuid,
  write_targets text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workflow_owner_idx ON workflow (owner_idp_id);

CREATE TABLE workflow_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  ir jsonb NOT NULL,
  ir_hash text NOT NULL,
  compiled_n8n_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_version_number_unique UNIQUE (workflow_id, version),
  CONSTRAINT workflow_version_ir_unique UNIQUE (workflow_id, ir_hash)
);

CREATE TABLE workflow_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
  version_id uuid REFERENCES workflow_version (id) ON DELETE SET NULL,
  trigger text NOT NULL CHECK (trigger IN ('webhook', 'schedule', 'poll', 'manual')),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'waiting_approval')),
  idempotency_key text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  replay_of uuid REFERENCES workflow_run (id) ON DELETE SET NULL,
  error jsonb
);

CREATE INDEX workflow_run_workflow_idx ON workflow_run (workflow_id, started_at DESC);
CREATE INDEX workflow_run_failed_idx ON workflow_run (state, started_at DESC) WHERE state = 'failed';

CREATE UNIQUE INDEX workflow_run_idempotency_unique
  ON workflow_run (workflow_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE workflow_run_node (
  run_id uuid NOT NULL REFERENCES workflow_run (id) ON DELETE CASCADE,
  node_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'waiting_approval', 'skipped')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error jsonb,
  PRIMARY KEY (run_id, node_id, attempt)
);

CREATE TABLE workflow_approval (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_run (id) ON DELETE CASCADE,
  node_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'waiting_approval'
    CHECK (state IN ('waiting_approval', 'approved', 'rejected', 'expired')),
  expires_at timestamptz NOT NULL,
  decided_by text,
  decided_at timestamptz,
  CONSTRAINT workflow_approval_node_unique UNIQUE (run_id, node_id)
);

CREATE TABLE credential_scope (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  workflow_id uuid REFERENCES workflow (id) ON DELETE CASCADE,
  operations text[] NOT NULL DEFAULT '{}',
  mode text NOT NULL CHECK (mode IN ('read', 'write')),
  secret_ref text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT credential_scope_expiry CHECK (expires_at > issued_at)
);

-- invariant 4: a write scope against a pass-through account is not a scope at all.
-- The cross-table check (integration_metadata.credential_granularity) is a trigger in 0009.

CREATE INDEX credential_scope_instance_idx ON credential_scope (instance_id) WHERE revoked_at IS NULL;

CREATE TABLE broker_policy (
  instance_id uuid PRIMARY KEY REFERENCES instance (id) ON DELETE CASCADE,
  allowed_operations text[] NOT NULL DEFAULT '{}',
  mode text NOT NULL CHECK (mode IN ('read', 'write')),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
