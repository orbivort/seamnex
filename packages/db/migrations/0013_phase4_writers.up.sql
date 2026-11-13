-- 0013 — Phase 4 writer support (ADR-BE-12).
--
-- Additive only. Every Phase 4 invariant that the design says belongs to the database already
-- exists (0009): render-set immutability, break-glass immutability, backup-versus-render-set,
-- built-image-before-backup, native token lifespan, `sync_state=unsupported` only for `fa_gate`,
-- and the 4–12 restore concurrency bound. Re-creating them here would be a second source of truth
-- for the same rule, so this migration adds only what the new writers need to exist.

-- ---------------------------------------------------------------------------------------------
-- 4E.3 — an operation-scoped token belongs to a workflow *version*, not to the workflow.
-- Revoking on disable means revoking the scope a run was compiled against; the next activation
-- mints a new one, so a stale token cannot be reused by a re-activated workflow.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE credential_scope
  ADD COLUMN version_id uuid REFERENCES workflow_version (id) ON DELETE CASCADE;

CREATE INDEX credential_scope_version_idx
  ON credential_scope (version_id)
  WHERE revoked_at IS NULL;

-- Mint is idempotent per call key, like every other mutating endpoint (ADR-BE-09 D6).
ALTER TABLE credential_scope ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX credential_scope_idempotency_unique
  ON credential_scope (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 4C.1 — per-instance backup schedule. `next_run_at` is the runner's only query; `cadence = off`
-- is a real state (a scheduled backup that was deliberately turned off), not a missing row.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE backup_schedule (
  instance_id uuid PRIMARY KEY REFERENCES instance (id) ON DELETE CASCADE,
  cadence text NOT NULL DEFAULT 'daily' CHECK (cadence IN ('off', 'daily', 'weekly', 'monthly')),
  hour_utc smallint NOT NULL DEFAULT 2 CHECK (hour_utc BETWEEN 0 AND 23),
  weekday smallint CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  timezone text NOT NULL DEFAULT 'UTC',
  retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
  next_run_at timestamptz,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_schedule_weekday_shape CHECK (
    (cadence = 'weekly' AND weekday IS NOT NULL)
    OR (cadence <> 'weekly' AND weekday IS NULL)
  ),
  CONSTRAINT backup_schedule_off_has_no_run CHECK (cadence <> 'off' OR next_run_at IS NULL)
);

CREATE INDEX backup_schedule_due_idx
  ON backup_schedule (next_run_at)
  WHERE next_run_at IS NOT NULL;

-- `ALTER DEFAULT PRIVILEGES` (0010) grants SELECT/INSERT only: a new table is append-only unless a
-- migration says otherwise in writing. The schedule is edited and deleted, so say so.
GRANT SELECT, INSERT, UPDATE, DELETE ON backup_schedule TO seamnex_app;

-- ---------------------------------------------------------------------------------------------
-- 4C.4 — the restore gate. A gated route projects no router at all; opening the gate re-projects
-- from the database. The flag is the whole state, which is what makes a failed restore fail safe.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE instance_route ADD COLUMN gated boolean NOT NULL DEFAULT false;

CREATE INDEX instance_route_published_idx
  ON instance_route (published, gated);

-- Per-product progress and the identity-verification evidence for a platform restore.
ALTER TABLE restore_run ADD COLUMN detail jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE restore_run
  ADD CONSTRAINT restore_run_detail_object CHECK (jsonb_typeof(detail) = 'object');

-- ---------------------------------------------------------------------------------------------
-- 4F.1 — break-glass elevation: one-time reveal and the in-product account it created. The reveal
-- token is stored as a hash, is single-use (`revealed_at`) and expires in seconds, not minutes.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE break_glass_session
  ADD COLUMN reveal_token_hash char(64),
  ADD COLUMN reveal_expires_at timestamptz,
  ADD COLUMN revealed_at timestamptz,
  ADD COLUMN product_account_ref text;

CREATE UNIQUE INDEX break_glass_reveal_token_unique
  ON break_glass_session (reveal_token_hash)
  WHERE reveal_token_hash IS NOT NULL;

-- The expiry job's only query: active grants that have run out.
CREATE INDEX break_glass_expiry_idx
  ON break_glass_session (expires_at)
  WHERE state IN ('approved', 'active');

-- ---------------------------------------------------------------------------------------------
-- 4F.3 — the hosted-service toggle is state; the restriction stays on the licence row, so the
-- reason for a refusal is data and not a message someone re-types.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE license_record ADD COLUMN hosted_service_enabled boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------------------------
-- 4F.4 — per-scope DSAR progress. `evidence` keeps prose; progress is machine-readable because the
-- privacy queue renders it and the completion rule reads it.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE dsar_request ADD COLUMN scope_progress jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE dsar_request
  ADD CONSTRAINT dsar_request_scope_progress_array CHECK (jsonb_typeof(scope_progress) = 'array');

-- ---------------------------------------------------------------------------------------------
-- 4B.2 / 4C.1 — the two hot queries the new writers add: the latest finished backup per instance,
-- and instances whose observation is older than the cycle.
-- ---------------------------------------------------------------------------------------------
CREATE INDEX backup_instance_finished_idx ON backup (instance_id, finished_at DESC);
CREATE INDEX instance_status_fresh_idx ON instance_status (observed_at, ready);
