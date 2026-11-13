ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM seamnex_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM seamnex_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT, INSERT ON TABLES FROM seamnex_app;

-- The leaf TRUNCATE guards were created here, on each partition. Dropping the function in 0009
-- would fail while they still depend on it, so they go first.
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
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', partition_name || '_no_truncate', partition_name);
  END LOOP;
END
$$;

DROP FUNCTION IF EXISTS seamnex_drop_partition(text, text);
DROP FUNCTION IF EXISTS seamnex_ensure_partition(text, text, timestamptz, timestamptz);

REVOKE ALL ON group_mapping FROM seamnex_sync;
REVOKE ALL ON sync_run FROM seamnex_sync;
REVOKE ALL ON idp_group FROM seamnex_sync;
REVOKE ALL ON idp_user FROM seamnex_sync;

REVOKE ALL ON schema_migration FROM seamnex_app;
REVOKE ALL ON audit_chain FROM seamnex_app;
REVOKE ALL ON SEQUENCE audit_event_seq FROM seamnex_app;
REVOKE ALL ON audit_anchor FROM seamnex_app;
REVOKE ALL ON audit_event FROM seamnex_app;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM seamnex_app;
REVOKE USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public FROM seamnex_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM seamnex_app;
