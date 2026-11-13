DROP INDEX IF EXISTS idp_group_member_subject_idx;
DROP TABLE IF EXISTS idp_group_member;
ALTER TABLE idp_user DROP COLUMN IF EXISTS created_at;
