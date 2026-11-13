-- Exact inverse of 0013_phase4_writers.up.sql.

DROP INDEX IF EXISTS instance_status_fresh_idx;
DROP INDEX IF EXISTS backup_instance_finished_idx;

ALTER TABLE dsar_request DROP CONSTRAINT IF EXISTS dsar_request_scope_progress_array;
ALTER TABLE dsar_request DROP COLUMN IF EXISTS scope_progress;

ALTER TABLE license_record DROP COLUMN IF EXISTS hosted_service_enabled;

DROP INDEX IF EXISTS break_glass_expiry_idx;
DROP INDEX IF EXISTS break_glass_reveal_token_unique;
ALTER TABLE break_glass_session
  DROP COLUMN IF EXISTS product_account_ref,
  DROP COLUMN IF EXISTS revealed_at,
  DROP COLUMN IF EXISTS reveal_expires_at,
  DROP COLUMN IF EXISTS reveal_token_hash;

ALTER TABLE restore_run DROP CONSTRAINT IF EXISTS restore_run_detail_object;
ALTER TABLE restore_run DROP COLUMN IF EXISTS detail;

DROP INDEX IF EXISTS instance_route_published_idx;
ALTER TABLE instance_route DROP COLUMN IF EXISTS gated;

DROP TABLE IF EXISTS backup_schedule;

DROP INDEX IF EXISTS credential_scope_idempotency_unique;
ALTER TABLE credential_scope DROP COLUMN IF EXISTS idempotency_key;

DROP INDEX IF EXISTS credential_scope_version_idx;
ALTER TABLE credential_scope DROP COLUMN IF EXISTS version_id;
