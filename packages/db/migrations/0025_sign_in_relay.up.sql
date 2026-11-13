-- 0025 — ADR-BE-22: the sign-in relay's one new table, one new secret scope and one new check type.
--
-- The relay signs a user into a product that keeps its own credential (FR-2.16 class c) by
-- submitting the product's own login form with a credential the platform holds *for that user*.
-- Three things have to exist in the database for that to be auditable rather than folklore:
--
--   * `product_account` — the mapping the relay refuses to invent at run time. One row per
--     (instance, subject); a second row for the same login is refused by the index below, because a
--     shared account destroys attribution in the product and is explicitly not allowed.
--   * a `product_account` secret scope — the credential belongs to one user on one instance. Filed
--     under `instance` it would be readable by anything that can open any instance secret, which is
--     the whole instance.
--   * a `relay_login` check type — a relayed password sign-in must never be recorded as `sso_login`
--     evidence. Reusing the SSO check type would let a relay look like single sign-on in the report
--     that exists to prevent exactly that claim.
--
-- Nothing here changes an existing row: the two CHECKs are replaced with a superset and the failure
-- mode of forgetting the grants is a loud permission error, not a silent one.

CREATE TABLE product_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  subject_idp_id text NOT NULL,
  -- The product-side login. Derived from the subject's `preferred_username` at provisioning time and
  -- never rewritten afterwards: the product's own audit log is the only record of who did what, and
  -- it is keyed on this value.
  login text NOT NULL,
  -- `secret.id`, following the no-foreign-key convention every other `secret_ref` in this schema
  -- uses. M15 owns the secret lifecycle; a cascade here would delete a credential behind its back.
  secret_ref text NOT NULL,
  -- `failed` is a real terminal-until-fixed state: the relay refuses the account and the operator
  -- sees why, instead of a stale cached session hiding a credential the product no longer accepts.
  state text NOT NULL CHECK (state IN ('pending', 'active', 'disabled', 'failed')),
  -- The last recorded reason, in the relay's own vocabulary (`admin_credential_missing`,
  -- `force_password_change`, …). Free text by design: a new failure code must not need a migration.
  last_error text,
  -- How many times provisioning was started. It bounds the retry of a cause a human can fix and
  -- makes a row left in `pending` by a crash recognisable as "started once, finished never".
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  provisioned_at timestamptz,
  rotated_at timestamptz,
  -- One product account per platform subject, per instance. The subject is `text`, matching
  -- `entitlement.subject_idp_id` and `idp_user.idp_id`.
  CONSTRAINT product_account_subject_unique UNIQUE (instance_id, subject_idp_id)
);

-- Rule 2 of the ADR, enforced where a race cannot bypass it: two subjects on one instance may not
-- converge on the same product login, and the comparison is case-insensitive because the product's
-- own login lookup is.
CREATE UNIQUE INDEX product_account_login_unique
  ON product_account (instance_id, lower(login));

-- The rotation pass asks for the oldest active credential on every tick.
CREATE INDEX product_account_rotation_idx
  ON product_account (rotated_at)
  WHERE state = 'active';

-- `ALTER DEFAULT PRIVILEGES` (0010) grants SELECT/INSERT only: a new table is append-only unless a
-- migration says otherwise in writing. This row is edited on every rotation and removed on
-- offboarding, so say so.
GRANT SELECT, INSERT, UPDATE, DELETE ON product_account TO seamnex_app;

-- ---------------------------------------------------------------------------------------------
-- A per-user product credential is a scope of its own.
--
-- `secret_scope_check` is the name Postgres generated for the inline CHECK in 0006
-- (`<table>_<column>_check`), so the drop below removes exactly what this migration replaces.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE secret DROP CONSTRAINT IF EXISTS secret_scope_check;

ALTER TABLE secret
  ADD CONSTRAINT secret_scope_check CHECK (
    scope IN ('instance', 'idp_client', 'workflow', 'platform', 'product_account')
  );

-- ---------------------------------------------------------------------------------------------
-- `relay_login` is deliberately not `sso_login`. The distinction is the point of the feature's
-- reporting: a relayed password sign-in is not, and may never be presented as, single sign-on.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE integration_check DROP CONSTRAINT IF EXISTS integration_check_check_type_check;

ALTER TABLE integration_check
  ADD CONSTRAINT integration_check_check_type_check CHECK (
    check_type IN (
      'http',
      'sso_login',
      'dns',
      'backup_registered',
      'webhook_registered',
      'relay_login'
    )
  );
