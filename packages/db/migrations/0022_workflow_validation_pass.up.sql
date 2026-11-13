-- 0022 — a validation pass is a recorded fact, not something inferred from `workflow.state`.
--
-- `GET /workflows` answered `validation.valid = state <> 'draft' AND state <> 'failed'`, on the
-- assumption that every non-draft row had passed a check. Nothing stored that check, so an imported
-- `disabled` workflow (created by `POST /workflows/import` without any pass) reported `valid: true`,
-- the console enabled Activate, and the POST answered `422 VALIDATION_FAILED` — the screen
-- contradicting the API it had just called. The issues themselves were computed by
-- `POST /workflows/:id/validate` and then dropped on the floor, so FR-5.6 ("activation blocked with
-- actionable node errors") had no way to reach the operator.
--
-- The pass is stored on the version it checked: a version is immutable in its IR, but its validation
-- state is metadata about it (exactly like `compiled_n8n_id`), and a re-run after a credential is
-- minted replaces it. `validated_at IS NULL` is the only honest way to say "never checked".
ALTER TABLE workflow_version
  ADD COLUMN validation_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN validated_at timestamptz;

-- The read path casts the column straight into `ValidationIssue[]`; a scalar or object here would
-- fail the response schema and take the whole workflow list down with it.
ALTER TABLE workflow_version
  ADD CONSTRAINT workflow_version_validation_issues_array
  CHECK (jsonb_typeof(validation_issues) = 'array');
