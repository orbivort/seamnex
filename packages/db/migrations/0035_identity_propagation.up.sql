-- 0035 — identity propagation stops at the platform entitlement (FR-2.4, AC-11, AC-48, S-8).
--
-- Three defects shared one root cause: the platform recorded a platform-side fact and called it a
-- product-side outcome.
--
--   * `entitlement.product_role` was the literal `'member'`, so a mapping from a group to a product
--     role could not be expressed at all: every product saw the same role no matter what the
--     administrator mapped. The mapping now carries the product-level role, and the entitlement
--     records it.
--   * `sync_state = 'applied'` was derived from the guarantee class alone. For a native product
--     nothing had been applied anywhere, so the state asserted a propagation that did not happen.
--     `applied_at` is the moment the platform's application completed; a null value means the
--     entitlement has never been applied, whatever the class would like to claim.
--   * `sync_run.p95_latency_ms` was measured over `idp_user` upserts — mirror writes, not the
--     directory change → product interval AC-48 asks about. Propagation samples are recorded
--     separately, per changed (subject, instance), from the membership observation to the applied
--     outcome, so the p95 the screen prints is the p95 it claims to print.
--
-- A sample is only written for a change, and the pairing of `detected_at` with `applied_at` is what
-- makes the number auditable: a reviewer can pick a row and see which change produced which delay.

ALTER TABLE group_mapping
  ADD COLUMN product_role text NOT NULL DEFAULT 'member',
  ADD CONSTRAINT group_mapping_product_role_shape CHECK (length(btrim(product_role)) > 0);

-- FR-1.26: `env_profile` carried no display name, so the API served the key as the name and the new
-- management screen had nothing to rename. Backfilled from the key, which is what the API already
-- returned — no host sees a change it did not make.
ALTER TABLE env_profile ADD COLUMN name text;
UPDATE env_profile SET name = key WHERE name IS NULL;
ALTER TABLE env_profile
  ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT env_profile_name_shape CHECK (length(btrim(name)) > 0);

COMMENT ON COLUMN env_profile.name IS
  'Operator-facing name (FR-1.26). `key` stays the stable identifier an instance pins itself to.';

-- FR-2.14/AC-41: which facts the last verification actually supplied.
--
-- `integration_metadata` defaults `operation_inventory`/`event_modes` to `[]` and
-- `credential_granularity` to `none`, so "the column is non-null" cannot distinguish a verified
-- empty list from one nobody ever looked at. The registry needs that distinction to stop presenting
-- a catalogue assumption as a verified fact with a fresh timestamp.
ALTER TABLE integration_metadata ADD COLUMN verified_facts text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN integration_metadata.verified_facts IS
  'Names of the facts onboarding verified (e.g. apiBaseUrl, operations). A fact absent here is still the catalogue assumption, whatever its column holds.';

COMMENT ON COLUMN group_mapping.product_role IS
  'The product-level role the mapping grants inside the product (FR-2.4). Free text because products name their own roles; `member` is the conservative default.';

ALTER TABLE entitlement ADD COLUMN applied_at timestamptz;

COMMENT ON COLUMN entitlement.applied_at IS
  'When the platform completed applying the grant to the product (push accepted, or identity client configured). NULL means never applied, which is what makes `pending` checkable (FR-2.4, AC-11).';

CREATE TABLE propagation_sample (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid NOT NULL REFERENCES sync_run (id) ON DELETE CASCADE,
  subject_idp_id text NOT NULL,
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  product_role text NOT NULL,
  guarantee_class text NOT NULL,
  /** When the mirror observed the membership that produced the grant. */
  detected_at timestamptz NOT NULL,
  /** When the entitlement reached its recorded state; NULL for a still-pending change. */
  applied_at timestamptz,
  latency_ms integer,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'pending', 'unsupported')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The reads that matter: the p95 for one run, and the pruning pass (`DELETE ... WHERE created_at <`).
CREATE INDEX propagation_sample_run_idx ON propagation_sample (sync_run_id);
CREATE INDEX propagation_sample_created_idx ON propagation_sample (created_at);

COMMENT ON TABLE propagation_sample IS
  'One row per membership change whose entitlement state changed in a sync cycle. `latency_ms` is `applied_at - detected_at`; a pending change has no latency because it has not propagated (FR-2.4, AC-48).';

ALTER TABLE sync_run
  ADD COLUMN p95_propagation_ms integer,
  ADD COLUMN propagation_samples integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN sync_run.p95_propagation_ms IS
  'p95 of `propagation_sample.latency_ms` for this run, over changes only. NULL/0 samples mean nothing was measured, never "instant" (AC-48).';
COMMENT ON COLUMN sync_run.propagation_samples IS
  'How many changes the p95 was computed over. Reported with the figure so a single sample cannot be read as a population.';

-- New table, so the append-only default from 0010 does not cover it: the sync role must insert and
-- prune, and the application role may read the evidence.
GRANT SELECT, INSERT, DELETE ON propagation_sample TO seamnex_app;
GRANT SELECT, INSERT, DELETE ON propagation_sample TO seamnex_sync;
