-- 0022 rollback: the read path falls back to the state-derived verdict, which is lossy but valid.
ALTER TABLE workflow_version
  DROP CONSTRAINT IF EXISTS workflow_version_validation_issues_array;

ALTER TABLE workflow_version
  DROP COLUMN IF EXISTS validated_at,
  DROP COLUMN IF EXISTS validation_issues;
