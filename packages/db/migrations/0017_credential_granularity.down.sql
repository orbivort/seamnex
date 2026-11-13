-- 0017 rollback: restore invariant 4 exactly as 0009 stated it.
--
-- The revoked scopes are not resurrected. `revoked_at` is an audit-worthy fact ("this credential
-- stopped being valid at this instant") and a rollback of a rule is not a statement that the
-- credentials it invalidated were legitimate.
DROP TRIGGER IF EXISTS catalog_entry_granularity_downgrade ON catalog_entry;
DROP FUNCTION IF EXISTS seamnex_catalog_granularity_downgrade();

DROP TRIGGER IF EXISTS integration_metadata_granularity_downgrade ON integration_metadata;
DROP FUNCTION IF EXISTS seamnex_granularity_downgrade();

CREATE OR REPLACE FUNCTION seamnex_credential_scope_mode() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  granularity text;
BEGIN
  IF NEW.mode = 'write' THEN
    SELECT credential_granularity INTO granularity
    FROM integration_metadata
    WHERE instance_id = NEW.instance_id;

    IF granularity IS NULL OR granularity = 'none' THEN
      RAISE EXCEPTION 'credential_scope.mode=write is rejected when credential_granularity is none or undeclared'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP FUNCTION IF EXISTS seamnex_effective_granularity(uuid);
