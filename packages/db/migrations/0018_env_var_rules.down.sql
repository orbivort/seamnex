-- Reverses 0018. The rules are a projection of `catalog/env/<KEY>.json`, so dropping the column
-- loses no authored content: the next reload re-derives it from the files.
ALTER TABLE env_schema_var
  DROP CONSTRAINT IF EXISTS env_schema_var_validation_rule_object;

ALTER TABLE env_schema_var
  DROP COLUMN IF EXISTS validation_rule;
