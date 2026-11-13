-- 0008 — Reliability, ingress and privacy (design §7.2, seventh group).

-- FR-1.21 / BR-3: a Dockerfile-path instance cannot be backed up without the image it built.
CREATE TABLE image_artefact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  image_digest text NOT NULL,
  source_revision text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  object_key text NOT NULL,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT image_artefact_digest_unique UNIQUE (instance_id, image_digest)
);

CREATE TABLE trigger_endpoint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  workflow_id uuid REFERENCES workflow (id) ON DELETE CASCADE,
  event_name text NOT NULL,
  -- Only the hash is stored: a leaked table does not yield a usable trigger URL.
  token_hash char(64) NOT NULL UNIQUE,
  hmac_secret_ref text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'failed')),
  CONSTRAINT trigger_endpoint_unique UNIQUE (instance_id, event_name)
);

CREATE TABLE trigger_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_endpoint_id uuid NOT NULL REFERENCES trigger_endpoint (id) ON DELETE CASCADE,
  delivery_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'accepted'
    CHECK (state IN ('accepted', 'duplicate', 'rejected', 'forwarded', 'failed')),
  CONSTRAINT trigger_delivery_dedupe UNIQUE (trigger_endpoint_id, delivery_id)
);

CREATE INDEX trigger_delivery_received_idx ON trigger_delivery (received_at DESC);

-- NFR-4.13: the subject is pseudonymous. Deleting the mapping *is* the erasure, while the audit
-- chain keeps only an opaque reference (invariant 6).
CREATE TABLE subject_ref (
  subject_ref char(64) PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  erased_at timestamptz
);

CREATE TABLE dsar_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_ref char(64) REFERENCES subject_ref (subject_ref) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('export', 'delete')),
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'in_progress', 'completed', 'rejected', 'expired')),
  opened_by text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX dsar_request_open_idx ON dsar_request (opened_at DESC) WHERE state <> 'completed';

CREATE TABLE personal_data_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('catalog_entry', 'platform')),
  scope_id text NOT NULL,
  locations jsonb NOT NULL DEFAULT '[]'::jsonb,
  export_procedure text NOT NULL,
  delete_procedure text NOT NULL,
  legal_basis text,
  verified_by text,
  verified_at timestamptz,
  CONSTRAINT personal_data_map_unique UNIQUE (scope_type, scope_id)
);
