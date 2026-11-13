DROP TABLE IF EXISTS machine_client;

DROP INDEX IF EXISTS policy_version_source_hash;
ALTER TABLE policy_version DROP COLUMN IF EXISTS source_hash;

ALTER TABLE idp_group DROP COLUMN IF EXISTS member_count;

ALTER TABLE idp_user DROP COLUMN IF EXISTS last_login_at;
ALTER TABLE idp_user DROP COLUMN IF EXISTS mfa_enrolled;
ALTER TABLE idp_user DROP COLUMN IF EXISTS job_title;
ALTER TABLE idp_user DROP COLUMN IF EXISTS display_name;
