-- 0010 — Privileges. The schema is the second half of several invariants: a trigger can be
-- bypassed by a superuser, a missing grant cannot.
--
-- Two rules this file exists to enforce, both of which the first version got wrong:
--   1. a partition is a table. Revoking on a partitioned parent does not revoke on its children,
--      and PostgreSQL clones row triggers to new partitions but *not* statement triggers. Audit
--      immutability therefore has to be re-applied per leaf, which `seamnex_ensure_partition` does.
--   2. the default privilege for a future table is the one nobody reviews. It is least privilege
--      here: a new table is append-only to `seamnex_app` unless a migration says otherwise in writing.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO seamnex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO seamnex_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO seamnex_app;

-- Invariant 6: the application role appends and reads, never rewrites (AD-20).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM seamnex_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_anchor FROM seamnex_app;
GRANT SELECT, INSERT ON audit_event TO seamnex_app;
GRANT SELECT, INSERT ON audit_anchor TO seamnex_app;

-- The chain tip is owned by the append trigger (SECURITY DEFINER); the application may only watch
-- it. An app role that could write the tip could point the chain anywhere.
GRANT SELECT ON audit_chain TO seamnex_app;

-- Invariant 6, per partition: `REVOKE ... ON audit_event` above covers only the parent.
DO $$
DECLARE
  partition_name text;
BEGIN
  FOR partition_name IN
    SELECT child.relname
      FROM pg_inherits
      JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
      JOIN pg_class child ON child.oid = pg_inherits.inhrelid
     WHERE parent.relname = 'audit_event'
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM seamnex_app', partition_name);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO seamnex_app', partition_name);
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION seamnex_audit_event_immutable()',
      partition_name || '_no_truncate',
      partition_name
    );
  END LOOP;
END
$$;

-- The chain sequence must be usable by the append path.
GRANT USAGE, SELECT ON SEQUENCE audit_event_seq TO seamnex_app;

-- `job_log` is append-only in the design (§7.2). Retention is a partition drop, not a delete.
-- No application code updates or deletes a log line, so the grant is withdrawn rather than trusted.
REVOKE UPDATE, DELETE, TRUNCATE ON job_log FROM seamnex_app;

DO $$
DECLARE
  partition_name text;
BEGIN
  FOR partition_name IN
    SELECT child.relname
      FROM pg_inherits
      JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
      JOIN pg_class child ON child.oid = pg_inherits.inhrelid
     WHERE parent.relname = 'job_log'
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM seamnex_app', partition_name);
  END LOOP;
END
$$;

-- The migration ledger is not an application table. `seamnex_app` could rewrite its own history.
REVOKE ALL ON schema_migration FROM seamnex_app;
GRANT SELECT ON schema_migration TO seamnex_app;

-- Invariant 10: the sync role mirrors the directory and nothing else.
GRANT SELECT, INSERT, UPDATE ON idp_user TO seamnex_sync;
GRANT SELECT, INSERT, UPDATE ON idp_group TO seamnex_sync;
GRANT SELECT, INSERT, UPDATE ON sync_run TO seamnex_sync;
GRANT SELECT ON group_mapping, role_binding, entitlement, instance TO seamnex_sync;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO seamnex_sync;
-- No INSERT/UPDATE/DELETE on group_mapping: a directory refresh cannot clobber a mapping decision.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON group_mapping FROM seamnex_sync;

-- ---------------------------------------------------------------------------------------------
-- Partition maintenance as a function, so the role that runs it cannot become the table's owner.
--
-- The first version had the scheduler role issue `CREATE TABLE ... PARTITION OF` itself. Whoever
-- creates a table owns it, and an owner needs no grant — so every partition the scheduler rolled
-- forward was fully writable by the application role, and the audit revoke above did not apply to
-- it. These functions run with the migration role's rights (SECURITY DEFINER), which keeps the
-- partition owned by the schema owner and lets the revoke stick.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seamnex_ensure_partition(
  p_parent text,
  p_name text,
  p_from timestamptz,
  p_to timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- The parent is an allowlist, not a parameter: a definer function must not be a general-purpose
  -- DDL primitive. The name is quoted everywhere, and must look like a partition of the parent.
  IF p_parent NOT IN ('audit_event', 'job_log') THEN
    RAISE EXCEPTION 'seamnex_ensure_partition: % is not a partitioned log table', p_parent
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_name !~ ('^' || p_parent || '_p[0-9]{6,8}$') THEN
    RAISE EXCEPTION 'seamnex_ensure_partition: % is not a valid partition name for %', p_name, p_parent
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- `public` is explicit: `search_path` is pinned to `pg_catalog, public` for hardening, and an
  -- unqualified CREATE TABLE would try to create the partition inside `pg_catalog`.
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
    p_name,
    p_parent,
    p_from,
    p_to
  );

  -- A new partition is owned by the definer, so the application has no implied rights on it.
  EXECUTE format('REVOKE ALL ON public.%I FROM seamnex_app', p_name);
  EXECUTE format('GRANT SELECT, INSERT ON public.%I TO seamnex_app', p_name);

  IF p_parent = 'audit_event' THEN
    -- Row triggers are cloned by PostgreSQL; a BEFORE TRUNCATE statement trigger is not.
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.seamnex_audit_event_immutable()',
      p_name || '_no_truncate',
      p_name
    );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION seamnex_drop_partition(p_parent text, p_name text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_parent NOT IN ('audit_event', 'job_log') THEN
    RAISE EXCEPTION 'seamnex_drop_partition: % is not a partitioned log table', p_parent
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_name !~ ('^' || p_parent || '_p[0-9]{6,8}$') THEN
    RAISE EXCEPTION 'seamnex_drop_partition: % is not a valid partition name for %', p_name, p_parent
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  EXECUTE format('DROP TABLE IF EXISTS public.%I', p_name);
END
$$;

REVOKE ALL ON FUNCTION seamnex_ensure_partition(text, text, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION seamnex_drop_partition(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seamnex_ensure_partition(text, text, timestamptz, timestamptz) TO seamnex_app;
GRANT EXECUTE ON FUNCTION seamnex_drop_partition(text, text) TO seamnex_app;

-- Future tables: append-only unless a migration grants more. A Phase 2 migration that needs
-- UPDATE/DELETE must say so explicitly; forgetting it produces a loud permission error at review
-- time, which is the failure mode we want.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT ON TABLES TO seamnex_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO seamnex_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO seamnex_app;
