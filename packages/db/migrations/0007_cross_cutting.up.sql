-- 0007 — Cross-cutting and projection tables (design §7.2, sixth group).

-- AD-18: the transactional outbox. A single claimer uses FOR UPDATE SKIP LOCKED, so the partial
-- index on undispatched rows is the queue's only read path.
CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  dispatched_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text
);

CREATE INDEX outbox_pending_idx ON outbox (id) WHERE dispatched_at IS NULL;
CREATE INDEX outbox_aggregate_idx ON outbox (aggregate_type, aggregate_id);

-- ADR-BE-05: compiled from packages/domain/src/capabilities.ts, never transcribed by hand.
CREATE TABLE policy_version (
  version integer PRIMARY KEY CHECK (version > 0),
  matrix jsonb NOT NULL,
  compiled_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX policy_version_one_active ON policy_version (is_active) WHERE is_active;

CREATE TABLE registry_snapshot (
  instance_id uuid PRIMARY KEY REFERENCES instance (id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now(),
  stale boolean NOT NULL DEFAULT false
);

CREATE INDEX registry_snapshot_stale_idx ON registry_snapshot (stale) WHERE stale;

-- Raw probe samples: 7-day retention, managed by the scheduler.
CREATE TABLE probe_result (
  id bigserial PRIMARY KEY,
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('http', 'container', 'login')),
  ok boolean NOT NULL,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX probe_result_instance_idx ON probe_result (instance_id, observed_at DESC);

CREATE TABLE integration_check (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  -- `check` is a reserved word; the column keeps the design's meaning under a legal name.
  check_type text NOT NULL
    CHECK (check_type IN ('http', 'sso_login', 'dns', 'backup_registered', 'webhook_registered')),
  ok boolean NOT NULL,
  detail text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX integration_check_instance_idx ON integration_check (instance_id, checked_at DESC);

-- Upstream source retained byte-for-byte (FR-1.19): the sha256 is the evidence that the platform
-- did not rewrite a customer's file.
CREATE TABLE source_file (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution_id uuid NOT NULL REFERENCES source_resolution (id) ON DELETE CASCADE,
  path text NOT NULL,
  sha256 char(64) NOT NULL,
  content text NOT NULL,
  CONSTRAINT source_file_unique UNIQUE (resolution_id, path)
);

CREATE TABLE render_file (
  render_set_id uuid NOT NULL REFERENCES render_set (id) ON DELETE CASCADE,
  path text NOT NULL,
  sha256 char(64) NOT NULL,
  content text NOT NULL,
  PRIMARY KEY (render_set_id, path)
);

CREATE TABLE capacity_reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid REFERENCES instance (id) ON DELETE CASCADE,
  cpu_milli integer NOT NULL CHECK (cpu_milli >= 0),
  memory_mb integer NOT NULL CHECK (memory_mb >= 0),
  disk_mb integer NOT NULL CHECK (disk_mb >= 0),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

CREATE INDEX capacity_reservation_live_idx ON capacity_reservation (instance_id) WHERE released_at IS NULL;

CREATE TABLE observability_profile (
  entry_key text PRIMARY KEY REFERENCES catalog_entry (key) ON DELETE CASCADE,
  dashboards jsonb NOT NULL DEFAULT '[]'::jsonb,
  rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog_commit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('scaffold', 'params', 'metadata')),
  actor text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_commit_sha_unique UNIQUE (sha)
);

CREATE TABLE alert_channel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('email', 'webhook')),
  target text NOT NULL,
  config_enc bytea,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid REFERENCES alert_channel (id) ON DELETE SET NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  subject text NOT NULL,
  body text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sent', 'failed', 'suppressed')),
  suppression_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX notification_queue_idx ON notification (state, created_at) WHERE state = 'queued';

-- Platform settings. `restore_concurrency` defaults to 4 and is bounded to 4–12 (DD-15, AC-52);
-- `session` lives in Redis and is deliberately absent here.
CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value, updated_by)
VALUES
  ('break_glass_max_minutes', '60'::jsonb, 'migration:0007'),
  ('restore_concurrency', '4'::jsonb, 'migration:0007'),
  ('oversubscription_factor', '1.25'::jsonb, 'migration:0007'),
  ('session_idle_minutes', '30'::jsonb, 'migration:0007'),
  ('session_absolute_hours', '12'::jsonb, 'migration:0007'),
  ('job_row_retention_days', '90'::jsonb, 'migration:0007'),
  ('job_log_retention_days', '30'::jsonb, 'migration:0007'),
  ('audit_retention_months', '14'::jsonb, 'migration:0007');
