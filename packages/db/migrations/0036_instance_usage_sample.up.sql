-- 0036 — per-instance consumption is measured, not assumed (FR-4.5, AC-39).
--
-- Before this table the capacity board's "per instance" rows were the *declared* deploy shape read
-- back from `instance.payload->'resources'`, so an idle container that reserved 2 GB and used 40 MiB
-- looked identical to one thrashing its limit. FR-4.5 asks for consumption, AC-39 asks for alerting
-- on it, and neither is answerable from an allocation ledger.
--
-- One row per instance per sampler pass. `containers` is recorded because a figure summed over zero
-- running containers is not "0 % CPU" — it is "nothing was measured", and the reader needs the
-- difference. The primary key is the natural one: a sample is identified by the instance and the
-- moment it was taken.
CREATE TABLE instance_usage_sample (
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  sampled_at timestamptz NOT NULL DEFAULT now(),
  cpu_milli integer NOT NULL CHECK (cpu_milli >= 0),
  memory_mb integer NOT NULL CHECK (memory_mb >= 0),
  disk_mb integer NOT NULL CHECK (disk_mb >= 0),
  containers integer NOT NULL CHECK (containers >= 0),
  PRIMARY KEY (instance_id, sampled_at)
);

COMMENT ON TABLE instance_usage_sample IS
  'Measured per-instance consumption (FR-4.5): container CPU/memory summed by the status sampler, disk from instance_volume.used_mb. Pruned at runtime; never edited.';
COMMENT ON COLUMN instance_usage_sample.containers IS
  'Running containers whose stats were summed. 0 means nothing was measured, not that the instance is idle.';

-- The reader asks for "the newest sample per instance" and the pruner asks for "older than the
-- retention window", so both directions are covered: the primary key serves the per-instance lookup,
-- this index serves the age-based delete.
CREATE INDEX instance_usage_sample_sampled_at_idx ON instance_usage_sample (sampled_at);

-- 0010 leaves a new table append-only (SELECT, INSERT) on purpose. Retention is a real delete, so the
-- grant is widened here in writing rather than inherited by accident.
GRANT SELECT, INSERT, DELETE ON instance_usage_sample TO seamnex_app;

-- Configurable alert thresholds (FR-4.5). The capacity board and `notification.evaluate()` read the
-- same three rows, which is what stops the screen from describing numbers no alert uses.
INSERT INTO settings (key, value, updated_by)
VALUES
  ('capacity_cpu_alert_percent', '75'::jsonb, 'migration:0036'),
  ('capacity_memory_alert_percent', '90'::jsonb, 'migration:0036'),
  ('capacity_disk_alert_percent', '85'::jsonb, 'migration:0036')
ON CONFLICT (key) DO NOTHING;
