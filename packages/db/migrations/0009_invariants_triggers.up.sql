-- 0009 — Cross-group foreign keys and the design §7.3 invariants.
--
-- Every invariant that the design says belongs to the database is a constraint or a trigger here.
-- The rule is: if a write must never be legal, it must fail with the application role connected —
-- not merely with the code path the current release happens to use.

-- ---------------------------------------------------------------------------------------------
-- Cross-group keys (declared here because the tables are created in different migrations).
-- ---------------------------------------------------------------------------------------------

ALTER TABLE catalog_entry
  ADD CONSTRAINT catalog_entry_primary_instance_fk
  FOREIGN KEY (primary_instance_id) REFERENCES instance (id) ON DELETE SET NULL;

ALTER TABLE instance_param
  ADD CONSTRAINT instance_param_instance_fk
  FOREIGN KEY (instance_id) REFERENCES instance (id) ON DELETE CASCADE;

ALTER TABLE instance_env_value
  ADD CONSTRAINT instance_env_value_render_set_fk
  FOREIGN KEY (applied_render_set_id) REFERENCES render_set (id) ON DELETE SET NULL;

-- render_set.plan_id and deployment_plan.render_set_id point at each other; defer the check to
-- commit so a plan and its render set can be inserted in one transaction.
ALTER TABLE render_set
  ADD CONSTRAINT render_set_plan_fk
  FOREIGN KEY (plan_id) REFERENCES deployment_plan (id) ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE workflow
  ADD CONSTRAINT workflow_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES workflow_version (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------------------------
-- Invariant 6 — append-only, hash-chained audit log.
-- The trigger, not the application, computes prev_hash/hash: any writer produces a valid chain,
-- including a future outbox consumer or an operator running SQL.
--
-- The chain tip lives in `audit_chain`, a single row locked FOR UPDATE on every append. An
-- advisory lock was the first design and it is not enough: an advisory lock serialises writers but
-- not *snapshots*, so under REPEATABLE READ a writer that waited for the lock still could not see
-- the row it waited for and forked the chain. A row lock makes the dependency visible to MVCC — the
-- waiting writer either sees the committed predecessor (READ COMMITTED) or gets 40001 and the
-- append fails closed (REPEATABLE READ / SERIALIZABLE).
-- ---------------------------------------------------------------------------------------------

CREATE TABLE audit_chain (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_hash char(64) NOT NULL DEFAULT repeat('0', 64),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO audit_chain (id) VALUES (1);

-- One canonicalisation, called by both the append trigger and the verifier in the application.
-- Fields are length-prefixed so a `|` inside a value cannot be used to make two different rows
-- hash identically; `id` is included so two rows cannot be swapped freely.
CREATE OR REPLACE FUNCTION seamnex_audit_hash(
  p_prev_hash text,
  p_seq bigint,
  p_ts timestamptz,
  p_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_outcome text,
  p_detail jsonb,
  p_request_id text
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(
    digest(
      COALESCE(p_prev_hash, repeat('0', 64)) || concat_ws(
        '|',
        'seamnex-audit-v2',
        p_seq::text,
        to_char(p_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        p_id::text,
        length(p_actor_type)::text || ':' || p_actor_type,
        length(p_actor_id)::text || ':' || p_actor_id,
        length(p_action)::text || ':' || p_action,
        length(p_target_type)::text || ':' || p_target_type,
        length(p_target_id)::text || ':' || p_target_id,
        length(p_outcome)::text || ':' || p_outcome,
        length(COALESCE(p_detail, '{}'::jsonb)::text)::text || ':' || COALESCE(p_detail, '{}'::jsonb)::text,
        length(COALESCE(p_request_id, ''))::text || ':' || COALESCE(p_request_id, '')
      ),
      'sha256'
    ),
    'hex'
  );
$$;

-- SECURITY DEFINER: the chain tip is maintained with the migration role's rights, so `seamnex_app` needs
-- no UPDATE on `audit_chain` and cannot move the tip itself. The function does nothing with
-- caller-supplied identifiers, and `search_path` is pinned, so the definer context is safe.
CREATE OR REPLACE FUNCTION seamnex_audit_event_append() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_hash char(64);
BEGIN
  -- Append order is the chain order, so the tip lock is taken *before* the sequence is consumed.
  -- Held to commit, which is the documented throughput ceiling of a single-writer audit log.
  SELECT last_hash INTO previous_hash FROM audit_chain WHERE id = 1 FOR UPDATE;

  -- The caller cannot choose its position in the chain: seq and ts are assigned here, not defaulted
  -- in the table definition, precisely so an explicit value cannot arrive before the lock.
  NEW.seq := nextval('audit_event_seq');
  NEW.ts := COALESCE(NEW.ts, now());
  NEW.prev_hash := previous_hash;
  NEW.hash := seamnex_audit_hash(
    previous_hash, NEW.seq, NEW.ts, NEW.id, NEW.actor_type, NEW.actor_id, NEW.action,
    NEW.target_type, NEW.target_id, NEW.outcome, NEW.detail, NEW.request_id
  );

  UPDATE audit_chain
     SET last_seq = NEW.seq, last_hash = NEW.hash, updated_at = now()
   WHERE id = 1;

  RETURN NEW;
END
$$;

CREATE TRIGGER audit_event_append
  BEFORE INSERT ON audit_event
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_audit_event_append();

-- Defence in depth: grants already deny UPDATE/DELETE (migration 0010). A role mistake must still
-- fail loudly rather than rewrite history.
CREATE OR REPLACE FUNCTION seamnex_audit_event_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_audit_event_immutable();

CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT
  EXECUTE FUNCTION seamnex_audit_event_immutable();

-- ---------------------------------------------------------------------------------------------
-- Invariant 2 — a render set is immutable once applied.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seamnex_render_set_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'render_set % is immutable after applied_at', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER render_set_immutable
  BEFORE UPDATE OR DELETE ON render_set
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_render_set_immutable();

-- ---------------------------------------------------------------------------------------------
-- Invariant 8 — break-glass mode is immutable; a grant cannot be extended.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seamnex_break_glass_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- `access_mode` may only change while the request is still a request. Approving and escalating in
  -- one statement was the bypass: the old check keyed on OLD.state, so 'requested' skipped it.
  IF NEW.access_mode IS DISTINCT FROM OLD.access_mode AND NEW.state <> 'requested' THEN
    RAISE EXCEPTION 'break_glass_session.access_mode is immutable once the request leaves requested'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Clearing the expiry was the other bypass: `expires_at := NULL` removed the bound entirely.
  IF OLD.expires_at IS NOT NULL
     AND (NEW.expires_at IS NULL OR NEW.expires_at > OLD.expires_at) THEN
    RAISE EXCEPTION 'break_glass_session.expires_at cannot be extended or cleared'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Who approved it, and whether they approved their own request, is evidence; it cannot be edited
  -- after approval.
  IF OLD.state IN ('approved', 'active')
     AND (
       NEW.approver IS DISTINCT FROM OLD.approver
       OR NEW.self_approved IS DISTINCT FROM OLD.self_approved
     ) THEN
    RAISE EXCEPTION 'break_glass_session approval evidence is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER break_glass_immutable
  BEFORE UPDATE ON break_glass_session
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_break_glass_immutable();

-- ---------------------------------------------------------------------------------------------
-- Invariant 1 — a deleted slug stays reserved for 30 days.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seamnex_instance_slug_reserved() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM instance
    WHERE slug = NEW.slug
      AND deleted_at IS NOT NULL
      AND deleted_at > now() - interval '30 days'
      AND id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'slug % is reserved for 30 days after deletion', NEW.slug
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER instance_slug_reserved
  BEFORE INSERT OR UPDATE OF slug ON instance
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_instance_slug_reserved();

-- ---------------------------------------------------------------------------------------------
-- Invariant 4 — a write scope is rejected when the product has no credential granularity.
-- ---------------------------------------------------------------------------------------------

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

    -- `granularity IS NULL` means there is no integration metadata row at all. Failing closed is the
    -- only defensible reading: a product with no declared granularity has not granted write access.
    IF granularity IS NULL OR granularity = 'none' THEN
      RAISE EXCEPTION 'credential_scope.mode=write is rejected when credential_granularity is none or undeclared'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER credential_scope_mode
  BEFORE INSERT OR UPDATE ON credential_scope
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_credential_scope_mode();

-- ---------------------------------------------------------------------------------------------
-- Native clients cannot hold a long-lived token (design §7.2, idp_client).
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seamnex_idp_client_lifespan() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mode text;
BEGIN
  SELECT auth_mode INTO mode FROM instance_route WHERE instance_id = NEW.instance_id;
  IF mode = 'native' AND NEW.access_token_lifespan_seconds > 300 THEN
    RAISE EXCEPTION 'a native client must not exceed a 300 s access token lifespan'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER idp_client_lifespan
  BEFORE INSERT OR UPDATE ON idp_client
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_idp_client_lifespan();

-- The other ordering hole: a client created before its route sees `mode = NULL` and passes. The
-- route is therefore re-checked when it becomes `native`, so the ceiling cannot be reached by
-- writing the two rows in the other order.
CREATE OR REPLACE FUNCTION seamnex_instance_route_lifespan_recheck() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.auth_mode = 'native' AND OLD.auth_mode IS DISTINCT FROM 'native' THEN
    IF EXISTS (
      SELECT 1 FROM idp_client
      WHERE instance_id = NEW.instance_id AND access_token_lifespan_seconds > 300
    ) THEN
      RAISE EXCEPTION 'a native client must not exceed a 300 s access token lifespan'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER instance_route_lifespan_recheck
  BEFORE UPDATE ON instance_route
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_instance_route_lifespan_recheck();

-- ---------------------------------------------------------------------------------------------
-- Invariant 7 — a backup cannot reference a render set that never ran, or another instance's.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seamnex_backup_render_set() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  applied timestamptz;
  owner uuid;
BEGIN
  IF NEW.render_set_id IS NOT NULL THEN
    SELECT applied_at, instance_id INTO applied, owner
    FROM render_set
    WHERE id = NEW.render_set_id;

    IF applied IS NULL THEN
      RAISE EXCEPTION 'backup references render_set % which was never applied', NEW.render_set_id
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.instance_id IS NOT NULL AND owner <> NEW.instance_id THEN
      RAISE EXCEPTION 'backup references a render_set owned by another instance'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER backup_render_set
  BEFORE INSERT OR UPDATE ON backup
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_backup_render_set();

-- ---------------------------------------------------------------------------------------------
-- Invariant 11 — a Dockerfile-path instance cannot be backed up without its built image.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seamnex_backup_requires_artefact() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  path text;
BEGIN
  IF NEW.kind = 'instance' AND NEW.instance_id IS NOT NULL THEN
    SELECT source_path INTO path FROM instance WHERE id = NEW.instance_id;
    IF path = 'dockerfile'
       AND NOT EXISTS (SELECT 1 FROM image_artefact WHERE instance_id = NEW.instance_id) THEN
      RAISE EXCEPTION 'image_artefact_missing: a Dockerfile instance cannot be backed up without its built image'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- UPDATE as well as INSERT: flipping `kind` or `instance_id` afterwards was the trivial bypass,
-- while the sibling `backup_render_set` trigger already covered UPDATE.
CREATE TRIGGER backup_requires_artefact
  BEFORE INSERT OR UPDATE ON backup
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_backup_requires_artefact();

-- ---------------------------------------------------------------------------------------------
-- Invariant 12 — `unsupported` is legal only for a forward-auth gate.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seamnex_entitlement_sync_state() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mode text;
BEGIN
  IF NEW.sync_state = 'unsupported' THEN
    SELECT auth_mode INTO mode FROM instance_route WHERE instance_id = NEW.instance_id;
    IF mode IS DISTINCT FROM 'fa_gate' THEN
      RAISE EXCEPTION 'sync_state=unsupported is legal only for an fa_gate instance'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER entitlement_sync_state
  BEFORE INSERT OR UPDATE ON entitlement
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_entitlement_sync_state();

-- ---------------------------------------------------------------------------------------------
-- Invariant 10 — the sync loop never writes a durable mapping.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seamnex_group_mapping_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('seamnex.writer', true) = 'identity-sync' THEN
    RAISE EXCEPTION 'group_mapping is never written by the sync loop'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER group_mapping_guard
  BEFORE INSERT OR UPDATE OR DELETE ON group_mapping
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_group_mapping_guard();

-- ---------------------------------------------------------------------------------------------
-- Settings bounds that a CHECK cannot express in JSONB (DD-15, AC-52).
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seamnex_settings_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  numeric_value integer;
BEGIN
  IF NEW.key = 'restore_concurrency' THEN
    numeric_value := (NEW.value #>> '{}')::integer;
    IF numeric_value < 4 OR numeric_value > 12 THEN
      RAISE EXCEPTION 'settings.restore_concurrency must be between 4 and 12'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER settings_guard
  BEFORE INSERT OR UPDATE ON settings
  FOR EACH ROW
  EXECUTE FUNCTION seamnex_settings_guard();
