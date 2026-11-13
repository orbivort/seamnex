ALTER TABLE workflow_version DROP COLUMN IF EXISTS n8n_credentials;

DROP INDEX IF EXISTS credential_scope_token_hash_unique;

ALTER TABLE credential_scope DROP COLUMN IF EXISTS token_hash;
