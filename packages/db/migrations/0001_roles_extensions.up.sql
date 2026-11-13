-- 0001 — cluster prerequisites.
--
-- Roles are cluster-scoped, so this migration is intentionally not reverted by its down pair:
-- dropping a role that another database depends on is not a schema rollback, it is an outage.
-- The ledger table `schema_migration` is created by the runner before any migration is applied,
-- because a migration cannot record itself.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- seamnex_migrator : owns the schema (used by CI and by seamnexctl bootstrap).
-- seamnex_app      : the control plane's DML role. No UPDATE/DELETE on the audit log.
-- seamnex_sync     : the identity sync writer. Never allowed to touch group_mapping (invariant 10).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seamnex_migrator') THEN
    CREATE ROLE seamnex_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seamnex_app') THEN
    CREATE ROLE seamnex_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seamnex_sync') THEN
    CREATE ROLE seamnex_sync NOLOGIN;
  END IF;
END
$$;

-- The migration role must be able to create objects in the target schema.
GRANT USAGE, CREATE ON SCHEMA public TO seamnex_migrator;
GRANT USAGE ON SCHEMA public TO seamnex_app;
GRANT USAGE ON SCHEMA public TO seamnex_sync;
