-- Reverses 0034: the evidence columns are dropped, so a rolled-back platform records a verdict
-- without its diff again. Nothing else depends on them — the columns are new and no reader falls
-- back to them — and the rows themselves stay, which keeps resolution history readable.
ALTER TABLE source_resolution
  DROP COLUMN IF EXISTS policy_violations,
  DROP COLUMN IF EXISTS patch_diff;
