-- 0011 — Phase 2 read models (ADR-BE-09).
--
-- Additive only, and deliberately no new table: `0010` sets the default privilege for future
-- tables to SELECT/INSERT, so a table created here would be append-only to `seamnex_app` by accident.
-- Every table Phase 2 writes already holds UPDATE/DELETE from `0010_grants.up.sql`.

-- D3: `/privacy/requests` is served from `dsar_request`. The queue needs a deadline and a
-- per-scope progress list; `evidence` keeps its existing jsonb shape (`{"notes": [...]}`).
ALTER TABLE dsar_request
  ADD COLUMN due_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  ADD COLUMN scopes jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE dsar_request
  ADD CONSTRAINT dsar_request_scopes_array CHECK (jsonb_typeof(scopes) = 'array');

-- D10: a projected document. `catalog_entry` and `instance` are projections of declarative
-- sources (ADR-BE-08, ADR-BE-09), and several API fields (description, owner, resources, usage,
-- upstream, event modes) have no relational column in schema v1. Rather than invent eighteen
-- columns that Phase 4 would then have to normalise anyway, the projection document is stored
-- once and the relational columns keep the keys that are filtered, joined or ordered on.
ALTER TABLE catalog_entry ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE catalog_entry_revision ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE instance ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb;

-- D1: audit history pages by `seq DESC`. The existing indexes are keyed on `ts`, which cannot
-- serve that order without sorting every live monthly partition.
CREATE INDEX audit_event_seq_idx ON audit_event (seq DESC);
CREATE INDEX audit_event_action_seq_idx ON audit_event (action, seq DESC);
CREATE INDEX audit_event_target_seq_idx
  ON audit_event (target_id, seq DESC)
  WHERE target_id IS NOT NULL;

-- D1: instance lists page by `created_at DESC, id` and filter by state. Soft-deleted rows are
-- excluded on every read path, so the partial predicate keeps the index small.
CREATE INDEX instance_listing_idx ON instance (created_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX instance_state_listing_idx
  ON instance (state, created_at DESC)
  WHERE deleted_at IS NULL;

-- Workflow lists order by `updated_at DESC`; the existing index is on the owner only.
CREATE INDEX workflow_updated_idx ON workflow (updated_at DESC, id);
