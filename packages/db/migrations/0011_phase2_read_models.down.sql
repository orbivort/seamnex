-- 0011 down — reverse every object created by 0011_phase2_read_models.up.sql.
DROP INDEX IF EXISTS workflow_updated_idx;
DROP INDEX IF EXISTS instance_state_listing_idx;
DROP INDEX IF EXISTS instance_listing_idx;
DROP INDEX IF EXISTS audit_event_target_seq_idx;
DROP INDEX IF EXISTS audit_event_action_seq_idx;
DROP INDEX IF EXISTS audit_event_seq_idx;

ALTER TABLE dsar_request DROP CONSTRAINT IF EXISTS dsar_request_scopes_array;
ALTER TABLE dsar_request DROP COLUMN IF EXISTS scopes;
ALTER TABLE dsar_request DROP COLUMN IF EXISTS due_at;

ALTER TABLE instance DROP COLUMN IF EXISTS payload;
ALTER TABLE catalog_entry_revision DROP COLUMN IF EXISTS payload;
ALTER TABLE catalog_entry DROP COLUMN IF EXISTS payload;
