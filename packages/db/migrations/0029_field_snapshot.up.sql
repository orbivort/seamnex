-- 0029 — runtime field discovery cache (FR-5.5).
--
-- The mapper needs the field names a write operation accepts. Those names belong to the product, not
-- to the catalog: a curated list drifts the moment the product is upgraded, and a mapping the author
-- was told was valid then fails at run time. The list is therefore read from the product through the
-- egress broker and cached here, keyed by the instance and the operation.
--
-- `status` is part of the row because "this product cannot describe its schema" is an answer worth
-- caching: without it, every drawer open would retry a product that has no metadata endpoint. Only
-- `available` rows may make a mapping an error — a cached outage must never block activation.
CREATE TABLE field_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  entry_key text NOT NULL,
  operation text NOT NULL,
  status text NOT NULL CHECK (status IN ('available', 'unsupported', 'unavailable')),
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  detail text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  retry_after timestamptz,
  CONSTRAINT field_snapshot_key_unique UNIQUE (instance_id, operation),
  -- The read path casts `fields` straight into `FieldDescriptor[]`; a scalar would fail the response
  -- schema and take the drawer down with it.
  CONSTRAINT field_snapshot_fields_array CHECK (jsonb_typeof(fields) = 'array')
);

-- The validation pass looks snapshots up by (instance, operation) for every node in one query, which
-- the unique constraint already serves. This index is for the retention/reload sweeps.
CREATE INDEX field_snapshot_fetched_idx ON field_snapshot (fetched_at);
