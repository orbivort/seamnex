-- 0033 — FR-1.36's product tier is its own job, so the kind list has to know it (FR-1.36, AC-30,
-- AC-52, ADR-BE-27).
--
-- The tier is queued when the administrative login releases the gate and it is a second job because
-- a stage cannot wait for a human to sign in. `deployment_job_kind_check` was written before that
-- kind existed, so on a real database the insert failed with a check violation: the gate opened, the
-- login was recorded, and the run sat in `products` with nothing running — the restore could never
-- reach `verify`, and a `running` platform run blocks every later one.
--
-- The list only widens; no row is rewritten, and an unknown kind is still refused. `JOB_KINDS` in
-- `packages/domain/src/enums.ts` carries the same values and must stay a superset, otherwise the job
-- list projects the tier as a deploy.
ALTER TABLE deployment_job
  DROP CONSTRAINT deployment_job_kind_check;

ALTER TABLE deployment_job
  ADD CONSTRAINT deployment_job_kind_check CHECK (
    kind IN (
      'deploy', 'build', 'start', 'stop', 'restart', 'upgrade', 'rollback', 'delete', 'backup',
      'restore', 'export', 'prepull', 'scaffold', 'verify', 'reconfigure', 'dsar',
      'platform-backup', 'platform-restore', 'platform-restore-products', 'synthetic'
    )
  );

COMMENT ON COLUMN deployment_job.kind IS
  'What the job does. `platform-restore-products` is the portfolio tier of a platform restore: it is queued when the administrative login releases the gate (FR-1.36).';
