DROP INDEX IF EXISTS workflow_run_node_sample_idx;

ALTER TABLE workflow_run_node
  DROP COLUMN IF EXISTS sample_truncated,
  DROP COLUMN IF EXISTS sample_captured_at,
  DROP COLUMN IF EXISTS sample_item;
