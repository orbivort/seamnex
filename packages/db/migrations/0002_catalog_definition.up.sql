-- 0002 — Catalog and declarative definition (design §7.2, first group).
--
-- These tables are a *projection* of the catalogue repository (ADR-BE-08). The repository wins;
-- a row here is queryable evidence of what the platform last read, not an authoring surface.

CREATE TABLE catalog_entry (
  key text PRIMARY KEY CHECK (key ~ '^D[1-9][0-9]{0,2}$'),
  domain text NOT NULL,
  product text NOT NULL,
  repo_url text,
  license_id text,
  -- invariant 5: a NULL guarantee class must fail at the database, not only in the UI.
  guarantee_class text NOT NULL
    CHECK (guarantee_class IN ('native', 'fa_header', 'fa_delegated', 'fa_gate')),
  packaging text NOT NULL CHECK (packaging IN ('compose', 'dockerfile', 'none')),
  primary_instance_id uuid,
  cluster text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- invariant 3: exactly one `primary_instance_id` per catalog entry, and D5/D6 point at the *same*
-- instance (design §7.3.3: "which is how 13 entries become 12 deployments"). The lookup index is
-- therefore deliberately NOT unique — a unique index here would make the documented shared-host
-- pair unwritable, which is the opposite of the invariant.
CREATE INDEX catalog_entry_primary_instance_idx
  ON catalog_entry (primary_instance_id)
  WHERE primary_instance_id IS NOT NULL;

CREATE TABLE catalog_entry_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_key text NOT NULL REFERENCES catalog_entry (key) ON DELETE CASCADE,
  git_sha text NOT NULL,
  content_hash text NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_entry_revision_unique UNIQUE (entry_key, git_sha)
);

CREATE TABLE deployment_definition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_key text NOT NULL REFERENCES catalog_entry (key) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES catalog_entry_revision (id) ON DELETE CASCADE,
  services jsonb NOT NULL DEFAULT '[]'::jsonb,
  volumes jsonb NOT NULL DEFAULT '[]'::jsonb,
  health jsonb NOT NULL DEFAULT '{}'::jsonb,
  reserved_ports integer[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployment_definition_one_per_revision UNIQUE (revision_id)
);

CREATE TABLE env_schema_var (
  entry_key text NOT NULL REFERENCES catalog_entry (key) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('string', 'integer', 'boolean', 'enum', 'url', 'secret')),
  required boolean NOT NULL DEFAULT false,
  default_value text,
  constraint_text text,
  conditional boolean NOT NULL DEFAULT false,
  secret boolean NOT NULL DEFAULT false,
  override_ceiling text NOT NULL
    CHECK (override_ceiling IN ('none', 'profile_only', 'profile_and_instance')),
  description text,
  PRIMARY KEY (entry_key, name)
);

CREATE TABLE env_profile (
  key text PRIMARY KEY,
  target text NOT NULL CHECK (target IN ('production', 'staging')),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE env_profile_value (
  profile_key text NOT NULL REFERENCES env_profile (key) ON DELETE CASCADE,
  var_name text NOT NULL,
  -- A profile may reference a shared secret; it never stores a secret value (design §7.2).
  value_enc bytea,
  secret_ref text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_key, var_name),
  CONSTRAINT env_profile_value_single_source CHECK ((value_enc IS NULL) <> (secret_ref IS NULL))
);

CREATE TABLE compose_policy (
  version integer PRIMARY KEY CHECK (version > 0),
  rules jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX compose_policy_one_active ON compose_policy (is_active) WHERE is_active;

CREATE TABLE scaffold_artefact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_key text NOT NULL REFERENCES catalog_entry (key) ON DELETE CASCADE,
  git_sha text,
  files jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Projection of `instances/<slug>/instance.yaml` (ADR-BE-08). content_hash is verified at boot;
-- a mismatch marks the instance `drift` (invariant 13, enforced by the boot check in M22).
CREATE TABLE instance_param (
  instance_id uuid PRIMARY KEY,
  git_sha text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz NOT NULL DEFAULT now()
);
