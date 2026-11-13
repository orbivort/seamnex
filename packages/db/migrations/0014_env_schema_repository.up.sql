-- 0014 — environment schemas under repository authority (AD-09, FR §3.1).
--
-- Until this migration `env_schema_var` was written by the development seed and by nothing else:
-- the one declarative artefact with no file, no revision and no way to remove a variable a product
-- had dropped. It becomes a projection of `catalog/env/<KEY>.json`, reconciled by
-- `POST /catalog/reload`, with the same provenance `catalog_entry_revision` gives entries.

CREATE TABLE env_schema_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_key text NOT NULL REFERENCES catalog_entry (key) ON DELETE CASCADE,
  git_sha text NOT NULL,
  content_hash text NOT NULL,
  variables jsonb NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT env_schema_revision_one_per_sha UNIQUE (entry_key, git_sha),
  CONSTRAINT env_schema_revision_variables_array CHECK (jsonb_typeof(variables) = 'array')
);

-- The reconcile's only read: the newest revision per entry, plus the hash it compares against.
CREATE INDEX env_schema_revision_latest_idx
  ON env_schema_revision (entry_key, loaded_at DESC);

ALTER TABLE env_schema_var
  ADD COLUMN options text[],
  -- Which revision declared this row. `NULL` is honest for rows written before the file existed.
  ADD COLUMN schema_revision_id uuid REFERENCES env_schema_revision (id) ON DELETE SET NULL;

-- `description` in the database, `purpose` in the API and in the file. One concept with two names
-- is how the declaration and the served projection drifted apart in the first place.
--
-- A rename is safe here only because code and schema ship as one artifact (`apps/api/Dockerfile`
-- copies this migration's own source tree). Applied against a *running* older API it would answer
-- `column "description" does not exist` on `GET /catalog/:key/env-schema` until that image is
-- rebuilt — which is exactly what happened in development. A column that must survive a rolling
-- deploy needs the expand/contract shape instead: add `purpose`, backfill, deploy the reader, then
-- drop `description` in a later migration.
ALTER TABLE env_schema_var RENAME COLUMN description TO purpose;

-- The boolean said "this variable is conditional"; the file says *when*. Keeping the boolean would
-- have the API invent the same English sentence for every row.
ALTER TABLE env_schema_var ADD COLUMN conditional_text text;

UPDATE env_schema_var
   SET conditional_text = 'Required when the product feature that uses it is enabled.'
 WHERE conditional;

ALTER TABLE env_schema_var DROP COLUMN conditional;
ALTER TABLE env_schema_var RENAME COLUMN conditional_text TO conditional;

-- Default privileges (0010) grant SELECT/INSERT only. A revision row is append-only, which is
-- exactly what SELECT/INSERT expresses; no UPDATE or DELETE is granted, so a correction is a new
-- revision rather than a quiet rewrite of history. `env_schema_var` already holds the full write
-- grant from 0010 (`GRANT … ON ALL TABLES`), which a rename does not disturb.
GRANT SELECT, INSERT ON env_schema_revision TO seamnex_app;
