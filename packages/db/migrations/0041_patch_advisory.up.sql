-- 0041 — FR-2.12 / FR-4.7 / NFR-4.7: upstream observation, and the advisory detail it produces.
--
-- `patch_record` existed since 0006 with no writer: the register was a projection of
-- `catalog_entry.payload.upstream`, whose `checkedAt` only moved when somebody edited JSON. The
-- scheduler pass introduced with this migration writes the row, so `source` distinguishes an
-- observed version pair from the catalogue fallback the screen used to present as tracking.
--
-- `patch_advisory` is keyed by entry rather than instance: an advisory affects a product, and every
-- instance of that product inherits it. `closed_at` is set when a later observation no longer sees
-- the advisory, so the age of the oldest *unapplied* update stays computable instead of being reset
-- by the newest pass.

ALTER TABLE patch_record
  ADD COLUMN advisory_id text,
  ADD COLUMN advisory_severity text
    CHECK (advisory_severity IN ('critical', 'high', 'medium', 'low', 'unknown')),
  ADD COLUMN advisory_url text,
  ADD COLUMN release_url text,
  -- Existing rows were written from the catalogue document, and saying so is the honest default.
  ADD COLUMN source text NOT NULL DEFAULT 'catalog'
    CHECK (source IN ('observed', 'catalog')),
  ADD COLUMN last_observed_at timestamptz;

CREATE TABLE patch_advisory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_key text NOT NULL REFERENCES catalog_entry (key) ON DELETE CASCADE,
  advisory_id text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'unknown')),
  summary text NOT NULL,
  url text,
  fixed_version text,
  published_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  -- NULL means still open; the register measures NFR-4.7's windows from `published_at`/`observed_at`.
  closed_at timestamptz,
  CONSTRAINT patch_advisory_one_per_id UNIQUE (entry_key, advisory_id)
);

-- The register's open-advisory read and the oldest-unapplied calculation.
CREATE INDEX patch_advisory_open_idx
  ON patch_advisory (entry_key)
  WHERE closed_at IS NULL;

-- INSERT is a new advisory, UPDATE closes one; nothing deletes, so history survives a feed outage.
GRANT SELECT, INSERT, UPDATE ON patch_advisory TO seamnex_app;

COMMENT ON TABLE patch_advisory IS
  'FR-2.12 open and closed upstream advisories per catalog entry, observed by the scheduler.';
