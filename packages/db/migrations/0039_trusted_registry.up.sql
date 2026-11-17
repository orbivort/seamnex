-- 0039 — NFR-4.16: the trusted-registry allow-list, as versioned state rather than a config string.
--
-- Before this migration the only allow-list in the platform was `SEAMNEX_SOURCE_ALLOWED_HOSTS`
-- (git clone), and an image from any registry could be pulled and started. NFR-4.16 asks for an
-- explicit, versioned allow-list maintained by the platform owner, with an audited change per
-- addition — so the list is append-only revision rows, exactly like `env_schema_revision` (0014):
-- a correction is a new revision, never an UPDATE of history.
--
-- There is deliberately no seed row here. The shipped default comes from the seed document
-- (`packages/db/src/seed/trusted-registries.json`, mirrored by `SEAMNEX_TRUSTED_REGISTRIES`), and a
-- literal copied into a migration would become a second, silently divergent default the day somebody
-- edits one of them.

CREATE TABLE trusted_registry_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Monotonic within the platform; the newest version is the allow-list in force.
  version integer NOT NULL,
  -- Hash of the canonical entry list, so "did this change?" is answerable without diffing JSON.
  content_hash text NOT NULL,
  -- `["docker.io/library", "ghcr.io/seamnex", ...]` — registry or registry/namespace strings.
  entries jsonb NOT NULL,
  note text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trusted_registry_revision_version_positive CHECK (version > 0),
  CONSTRAINT trusted_registry_revision_version_unique UNIQUE (version),
  CONSTRAINT trusted_registry_revision_entries_array CHECK (jsonb_typeof(entries) = 'array'),
  -- An empty allow-list would refuse every image, including the scanner; refusing it here turns a
  -- typo into a rejected revision instead of a platform that cannot deploy anything.
  CONSTRAINT trusted_registry_revision_entries_nonempty CHECK (jsonb_array_length(entries) > 0)
);

-- The guard's only read: the newest revision. `version DESC` rather than `created_at DESC` so a
-- clock skew between two workers cannot reorder the list that is enforced.
CREATE INDEX trusted_registry_revision_current_idx
  ON trusted_registry_revision (version DESC);

-- Append-only: SELECT and INSERT only, so no code path can rewrite an approved list in place.
GRANT SELECT, INSERT ON trusted_registry_revision TO seamnex_app;

COMMENT ON TABLE trusted_registry_revision IS
  'NFR-4.16 trusted registry/namespace allow-list; append-only, newest version wins.';
