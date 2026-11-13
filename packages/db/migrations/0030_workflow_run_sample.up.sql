-- 0030 — the item a node produced, kept so the mapper can offer real field names (FR-5.5).
--
-- `workflow_run_node` recorded state, duration and error, but not the data that flowed through it.
-- The mapper therefore asked an author to type a path like `data[0].lastName` from memory, with no
-- way to see whether the previous step produced `data`, `items` or `results`. n8n already hands the
-- execution detail back with `includeData=true` (the mirror reads it to count items), so capturing
-- one item costs no extra call.
--
-- The column is the *output* item of that node — the exact object the downstream node's `$json`
-- refers to. It is redacted and capped by the mirror before it lands here; `sample_truncated` says
-- the stored item is not the whole payload, so the UI never implies completeness.
ALTER TABLE workflow_run_node
  ADD COLUMN sample_item jsonb,
  ADD COLUMN sample_captured_at timestamptz,
  ADD COLUMN sample_truncated boolean NOT NULL DEFAULT false;

-- The retention sweep nulls expired samples; a partial index keeps that sweep off the run rows that
-- never carried one.
CREATE INDEX workflow_run_node_sample_idx
  ON workflow_run_node (sample_captured_at)
  WHERE sample_item IS NOT NULL;
