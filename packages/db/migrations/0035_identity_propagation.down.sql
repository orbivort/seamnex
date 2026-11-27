-- Reverses 0035. The evidence table goes first (it references `sync_run` and `instance`); the
-- columns drop last. Dropping `product_role` loses the mapping's product-side role, which the
-- previous schema had nowhere to keep, so a rollback knowingly returns to the literal `member`.
DROP INDEX IF EXISTS propagation_sample_created_idx;
DROP INDEX IF EXISTS propagation_sample_run_idx;
DROP TABLE IF EXISTS propagation_sample;

ALTER TABLE sync_run
  DROP COLUMN IF EXISTS propagation_samples,
  DROP COLUMN IF EXISTS p95_propagation_ms;

ALTER TABLE entitlement DROP COLUMN IF EXISTS applied_at;

ALTER TABLE group_mapping
  DROP CONSTRAINT IF EXISTS group_mapping_product_role_shape,
  DROP COLUMN IF EXISTS product_role;

ALTER TABLE env_profile
  DROP CONSTRAINT IF EXISTS env_profile_name_shape,
  DROP COLUMN IF EXISTS name;

ALTER TABLE integration_metadata DROP COLUMN IF EXISTS verified_facts;
