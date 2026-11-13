-- 0017 — credential granularity as one rule (FR-2.14, FR-5.3, C-11).
--
-- The feature shipped with its parts disconnected:
--
--   * invariant 4 (0009) rejected `mode = 'write'` only when the granularity was `'none'`, so an
--     `account` product — which by definition cannot issue a credential narrow enough to bound a
--     write — was write-eligible. FR-5.3 says the workflow "shall be limited to read operations"
--     for any product that cannot issue scoped credentials, and C-11 says the same in one line;
--   * the check only ran on `credential_scope`, so lowering a product's granularity afterwards left
--     every live write scope valid — the invariant was true at insert time and false a second later;
--   * it read `integration_metadata` only, which nothing wrote. A deployment whose verification had
--     been recorded in the catalog document (the only place the console could write it) therefore
--     read as "no granularity declared" and fail-closed to `none`.
--
-- Three changes fix that, and they are the reason this is a migration rather than a service edit:
-- the rule has to hold for writers that never go through the broker's code path.

-- ---------------------------------------------------------------------------------------------
-- One resolver, so the database and the application cannot disagree about the declared fact.
--
-- The per-instance row is the verified record (FR-2.14: verification is performed against a running
-- deployment). The catalog document is the reviewed entry-level record, which is what a verification
-- made *before* the first deployment lands in. Preferring the per-instance row and falling back to
-- the entry keeps "verified values supersede catalog assumptions" true in both directions; a value
-- that is neither declared nor recognised resolves to `none`, which is the only defensible default.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seamnex_effective_granularity(p_instance_id uuid) RETURNS text
LANGUAGE sql
STABLE
AS $$
  WITH declared AS (
    SELECT m.credential_granularity AS value, 1 AS rank
      FROM integration_metadata m
     WHERE m.instance_id = p_instance_id
    UNION ALL
    SELECT c.payload #>> '{integration,credentialGranularity}', 2
      FROM instance i
      JOIN catalog_entry c ON c.key = i.entry_key
     WHERE i.id = p_instance_id
  )
  SELECT coalesce(
    (SELECT value
       FROM declared
      WHERE value IN ('scoped', 'account', 'none')
      ORDER BY rank
      LIMIT 1),
    'none'
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- Invariant 4, restated: an active write scope requires `scoped` granularity.
--
-- `revoked_at IS NULL` is part of the predicate on purpose. Revocation is an UPDATE that keeps
-- `mode = 'write'`, and a rule that refused it would make a downgrade impossible to enforce — the
-- trigger would block the very repair it is supposed to trigger.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seamnex_credential_scope_mode() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  granularity text;
BEGIN
  IF NEW.mode = 'write' AND NEW.revoked_at IS NULL THEN
    granularity := seamnex_effective_granularity(NEW.instance_id);
    IF granularity <> 'scoped' THEN
      RAISE EXCEPTION 'credential_scope.mode=write requires credential_granularity = ''scoped'' (credential granularity is %)', granularity
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- The invariant after the fact: recording a lower granularity revokes the write scopes it
-- invalidates, in the same statement that records the change.
--
-- Failing the downgrade instead would leave the operator unable to record a fact that is already
-- true of the product, and there is no console screen that can revoke a scope one at a time. The
-- workflow that depended on the scope then fails validation with CREDENTIAL_MISSING, which is the
-- honest outcome: its write credential no longer exists.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seamnex_granularity_downgrade() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.credential_granularity IS DISTINCT FROM OLD.credential_granularity
     AND NEW.credential_granularity <> 'scoped' THEN
    UPDATE credential_scope
       SET revoked_at = now()
     WHERE instance_id = NEW.instance_id
       AND mode = 'write'
       AND revoked_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER integration_metadata_granularity_downgrade
  AFTER UPDATE OF credential_granularity ON integration_metadata
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_granularity_downgrade();

-- The same downgrade declared on the catalog entry, for instances whose verification never reached
-- a per-instance row (the entry was verified before it was deployed). Without this, a reload that
-- lowered the entry's granularity would leave those scopes live.
CREATE OR REPLACE FUNCTION seamnex_catalog_granularity_downgrade() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  declared_before text := OLD.payload #>> '{integration,credentialGranularity}';
  declared_after text := NEW.payload #>> '{integration,credentialGranularity}';
BEGIN
  IF declared_after IS DISTINCT FROM declared_before AND coalesce(declared_after, 'none') <> 'scoped' THEN
    UPDATE credential_scope cs
       SET revoked_at = now()
     WHERE cs.mode = 'write'
       AND cs.revoked_at IS NULL
       AND cs.instance_id IN (
         SELECT i.id
           FROM instance i
           LEFT JOIN integration_metadata m ON m.instance_id = i.id
          WHERE i.entry_key = NEW.key
            AND m.instance_id IS NULL
       );
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER catalog_entry_granularity_downgrade
  AFTER UPDATE OF payload ON catalog_entry
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_catalog_granularity_downgrade();
