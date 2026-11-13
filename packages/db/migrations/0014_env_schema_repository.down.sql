-- Reverses 0014. The `conditional` sentence becomes a boolean again: any non-null text meant
-- "conditional", so the information that is lost is the wording, not the flag.
ALTER TABLE env_schema_var ADD COLUMN conditional_flag boolean NOT NULL DEFAULT false;

UPDATE env_schema_var SET conditional_flag = (conditional IS NOT NULL);

ALTER TABLE env_schema_var DROP COLUMN conditional;
ALTER TABLE env_schema_var RENAME COLUMN conditional_flag TO conditional;

ALTER TABLE env_schema_var RENAME COLUMN purpose TO description;

ALTER TABLE env_schema_var
  DROP COLUMN schema_revision_id,
  DROP COLUMN options;

DROP TABLE IF EXISTS env_schema_revision;
