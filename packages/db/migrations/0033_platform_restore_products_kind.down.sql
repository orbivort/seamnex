-- Reverses 0033: the previous kind list, restored as NOT VALID.
--
-- A row of the new kind may already exist — the tier job of a restore that ran under this release —
-- and a validated constraint would refuse to be created over it, turning a rollback into a manual
-- cleanup while the platform is possibly mid-incident. `NOT VALID` enforces the old list for every
-- new insert and leaves the existing row alone; the data stays readable, which is what a rollback is
-- for.
ALTER TABLE deployment_job
  DROP CONSTRAINT deployment_job_kind_check;

ALTER TABLE deployment_job
  ADD CONSTRAINT deployment_job_kind_check CHECK (
    kind IN (
      'deploy', 'build', 'start', 'stop', 'restart', 'upgrade', 'rollback', 'delete', 'backup',
      'restore', 'export', 'prepull', 'scaffold', 'verify', 'reconfigure', 'dsar',
      'platform-backup', 'platform-restore', 'synthetic'
    )
  ) NOT VALID;

COMMENT ON COLUMN deployment_job.kind IS NULL;
