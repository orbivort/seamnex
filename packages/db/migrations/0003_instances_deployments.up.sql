-- 0003 — Runtime: instances and deployments (design §7.2, second group).

CREATE TABLE instance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_key text NOT NULL REFERENCES catalog_entry (key),
  slug text NOT NULL
    CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$' AND char_length(slug) BETWEEN 2 AND 48),
  domain_route text NOT NULL,
  profile_key text REFERENCES env_profile (key),
  state text NOT NULL CHECK (
    state IN (
      'requested', 'validating', 'resolving', 'building', 'rendering', 'planned', 'deploying',
      'integrating', 'verifying', 'ready', 'degraded', 'failed', 'rolling_back', 'upgrading',
      'stopping', 'stopped', 'starting', 'restarting', 'deleting', 'deleted'
    )
  ),
  desired_state text NOT NULL DEFAULT 'running' CHECK (desired_state IN ('running', 'stopped')),
  source_path text CHECK (source_path IN ('compose', 'dockerfile', 'scaffold')),
  owner_user_id text,
  node_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- invariant 1: uniqueness applies to live instances; deleted rows are retained for the ledger
-- and for backup provenance. The 30-day reservation is enforced by a trigger (migration 0009).
CREATE UNIQUE INDEX instance_slug_live_unique ON instance (slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX instance_domain_route_live_unique ON instance (domain_route) WHERE deleted_at IS NULL;
CREATE INDEX instance_entry_idx ON instance (entry_key);

CREATE TABLE instance_service (
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  service_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('primary', 'database', 'cache', 'search', 'worker')),
  image_ref text NOT NULL,
  image_digest text,
  internal_url text,
  PRIMARY KEY (instance_id, service_name)
);

CREATE TABLE instance_volume (
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  name text NOT NULL,
  mount_path text NOT NULL,
  host_path text,
  quota_mb integer CHECK (quota_mb IS NULL OR quota_mb > 0),
  PRIMARY KEY (instance_id, name)
);

-- Projection cache of the per-variable resolution outcome (design §7.2). The authority for
-- non-secret overrides is the repository; for secrets it is M15. The shape check keeps a
-- secret reference out of a plaintext column.
CREATE TABLE instance_env_value (
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  var_name text NOT NULL,
  source text NOT NULL CHECK (source IN ('default', 'profile', 'instance', 'secret')),
  value_enc bytea,
  secret_ref text,
  applied_render_set_id uuid,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, var_name),
  CONSTRAINT instance_env_value_source_shape CHECK (
    (source = 'secret' AND secret_ref IS NOT NULL)
    OR (source <> 'secret' AND value_enc IS NOT NULL)
  )
);

CREATE TABLE source_resolution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  path text NOT NULL CHECK (path IN ('compose', 'dockerfile', 'scaffold')),
  source_url text,
  source_revision text,
  resolved_image_ref text,
  resolved_image_digest text,
  policy_verdict text CHECK (policy_verdict IN ('allowed', 'blocked', 'unsafe_approved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX source_resolution_instance_idx ON source_resolution (instance_id, created_at DESC);

CREATE TABLE render_set (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  plan_id uuid,
  content_hash text NOT NULL,
  files jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CONSTRAINT render_set_content_unique UNIQUE (instance_id, content_hash)
);

CREATE INDEX render_set_instance_idx ON render_set (instance_id, created_at DESC);

CREATE TABLE deployment_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  render_set_id uuid REFERENCES render_set (id) ON DELETE SET NULL,
  action text NOT NULL,
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  capacity_verdict text CHECK (capacity_verdict IN ('admitted', 'refused', 'unknown')),
  policy_verdict text CHECK (policy_verdict IN ('allowed', 'blocked', 'unsafe_approved')),
  approved_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deployment_plan_instance_idx ON deployment_plan (instance_id, created_at DESC);

CREATE TABLE deployment_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid REFERENCES instance (id) ON DELETE CASCADE,
  -- BullMQ queue name is derived from this lane (ADR-BE-07, deliverable 1.4).
  lane text NOT NULL,
  kind text NOT NULL CHECK (
    kind IN (
      'deploy', 'build', 'start', 'stop', 'restart', 'upgrade', 'rollback', 'delete', 'backup',
      'restore', 'export', 'prepull', 'scaffold', 'verify', 'reconfigure', 'dsar',
      'platform-backup', 'platform-restore', 'synthetic'
    )
  ),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  idempotency_key text,
  requested_by text,
  error_code text,
  error_detail text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- Idempotency: globally unique while present. The scheduler reaper NULLs keys older than 24 h,
-- which is what turns a unique index into a 24-hour window (a `now()`-based partial index is
-- not immutable and cannot be built).
CREATE UNIQUE INDEX deployment_job_idempotency_unique
  ON deployment_job (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Lane rule: one active job per instance; a second request answers 409 instance_busy.
CREATE UNIQUE INDEX deployment_job_one_active_per_instance
  ON deployment_job (instance_id)
  WHERE state IN ('queued', 'running') AND instance_id IS NOT NULL;

-- Platform-tier jobs (backup/restore of the platform itself) share one exclusive lane.
CREATE UNIQUE INDEX deployment_job_one_active_platform
  ON deployment_job (lane)
  WHERE state IN ('queued', 'running') AND instance_id IS NULL;

CREATE INDEX deployment_job_listing_idx ON deployment_job (created_at DESC, id);
CREATE INDEX deployment_job_instance_idx ON deployment_job (instance_id, created_at DESC);

CREATE TABLE job_step (
  job_id uuid NOT NULL REFERENCES deployment_job (id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq > 0),
  name text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  started_at timestamptz,
  finished_at timestamptz,
  message text,
  PRIMARY KEY (job_id, seq)
);

-- Append-only job log, partitioned by day so retention is a partition drop (NFR-6.7, CL-23).
CREATE SEQUENCE job_log_id_seq;

CREATE TABLE job_log (
  id bigint NOT NULL DEFAULT nextval('job_log_id_seq'),
  job_id uuid NOT NULL REFERENCES deployment_job (id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq > 0),
  ts timestamptz NOT NULL DEFAULT now(),
  stream text NOT NULL CHECK (stream IN ('system', 'stdout', 'stderr')),
  line text NOT NULL,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX job_log_job_idx ON job_log (job_id, seq);
-- SSE replay reads `WHERE job_id = $1 AND id > $2 ORDER BY id`, which the (job_id, seq) index
-- cannot serve: it scanned every live partition instead.
CREATE INDEX job_log_job_id_idx ON job_log (job_id, id);
CREATE INDEX job_log_ts_idx ON job_log (ts DESC);

-- A 30-day window is created here; the scheduler rolls it forward and drops expired partitions.
DO $$
DECLARE
  day_start date := date_trunc('day', now() AT TIME ZONE 'UTC')::date;
  offset_days integer;
  partition_name text;
BEGIN
  FOR offset_days IN 0..29 LOOP
    partition_name := format('job_log_p%s', to_char(day_start + offset_days, 'YYYYMMDD'));
    -- Boundaries are midnight UTC regardless of the server's local timezone.
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF job_log FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      ((day_start + offset_days)::timestamp AT TIME ZONE 'UTC'),
      ((day_start + offset_days + 1)::timestamp AT TIME ZONE 'UTC')
    );
  END LOOP;
END
$$;

CREATE TABLE instance_status (
  instance_id uuid PRIMARY KEY REFERENCES instance (id) ON DELETE CASCADE,
  state text NOT NULL CHECK (
    state IN (
      'requested', 'validating', 'resolving', 'building', 'rendering', 'planned', 'deploying',
      'integrating', 'verifying', 'ready', 'degraded', 'failed', 'rolling_back', 'upgrading',
      'stopping', 'stopped', 'starting', 'restarting', 'deleting', 'deleted'
    )
  ),
  ready boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('poll', 'push', 'manual')),
  reason text
);

CREATE TABLE container_status (
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  container_id text NOT NULL,
  service text NOT NULL,
  state text NOT NULL CHECK (state IN ('created', 'running', 'paused', 'restarting', 'exited', 'dead')),
  health text NOT NULL CHECK (health IN ('healthy', 'unhealthy', 'starting', 'none')),
  restart_count integer NOT NULL DEFAULT 0 CHECK (restart_count >= 0),
  started_at timestamptz,
  exit_code integer,
  exit_reason text,
  image_digest text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, container_id)
);
