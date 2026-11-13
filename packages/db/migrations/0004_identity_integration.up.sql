-- 0004 — Integration and identity (design §7.2, third group).

CREATE TABLE idp_client (
  instance_id uuid PRIMARY KEY REFERENCES instance (id) ON DELETE CASCADE,
  client_id text NOT NULL UNIQUE,
  client_secret_ref text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('oidc', 'saml')),
  redirect_uris text[] NOT NULL DEFAULT '{}',
  -- FR-2.2: a native client must not outlive a short-lived token. The `native` ceiling of 300 s is
  -- enforced against instance_route.auth_mode by a trigger in migration 0009.
  access_token_lifespan_seconds integer NOT NULL DEFAULT 300
    CHECK (access_token_lifespan_seconds BETWEEN 30 AND 86400),
  offline_access_disabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE instance_route (
  instance_id uuid PRIMARY KEY REFERENCES instance (id) ON DELETE CASCADE,
  host text NOT NULL,
  path_prefix text,
  publish_model text NOT NULL CHECK (publish_model IN ('subdomain', 'subpath')),
  tls_mode text NOT NULL DEFAULT 'acme' CHECK (tls_mode IN ('acme', 'internal')),
  auth_mode text NOT NULL CHECK (auth_mode IN ('native', 'fa_header', 'fa_delegated', 'fa_gate')),
  published boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- invariant 1: host uniqueness is case-insensitive.
CREATE UNIQUE INDEX instance_route_host_unique ON instance_route (lower(host));

-- Verified facts (FR-2.14). Keyed per instance because the verification is performed against a
-- running deployment; `entry_key` is carried so the catalog screen can read it without a join on
-- the instance's mutable state.
CREATE TABLE integration_metadata (
  instance_id uuid PRIMARY KEY REFERENCES instance (id) ON DELETE CASCADE,
  entry_key text NOT NULL REFERENCES catalog_entry (key) ON DELETE CASCADE,
  api_base_url text,
  auth_method text,
  guarantee_class_verified text
    CHECK (guarantee_class_verified IN ('native', 'fa_header', 'fa_delegated', 'fa_gate')),
  operation_inventory jsonb NOT NULL DEFAULT '[]'::jsonb,
  event_modes jsonb NOT NULL DEFAULT '[]'::jsonb,
  credential_granularity text NOT NULL DEFAULT 'none'
    CHECK (credential_granularity IN ('scoped', 'account', 'none')),
  session_max_minutes integer CHECK (session_max_minutes IS NULL OR session_max_minutes > 0),
  -- FR-3.8: residual-session disclosure must come from a verified fact, never an inference.
  slo_supported boolean,
  verified_by text,
  verified_at timestamptz,
  next_review_at timestamptz
);

CREATE INDEX integration_metadata_entry_idx ON integration_metadata (entry_key);

CREATE TABLE idp_user (
  idp_id text PRIMARY KEY,
  username text NOT NULL,
  email text,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idp_user_username_unique ON idp_user (lower(username));

-- invariant 10: the group mirror has no mapping columns. A mapping lives in group_mapping only.
CREATE TABLE idp_group (
  idp_id text PRIMARY KEY,
  path text NOT NULL,
  parent_id text REFERENCES idp_group (idp_id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idp_group_path_unique UNIQUE (path)
);

CREATE TABLE group_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_idp_id text NOT NULL REFERENCES idp_group (idp_id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('R1', 'R2', 'R3', 'R4', 'R5', 'R6')),
  scope_type text NOT NULL CHECK (scope_type IN ('platform', 'domain', 'instance')),
  scope_id text,
  propagate_to_product boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_mapping_unique UNIQUE (group_idp_id, role, scope_type, scope_id),
  CONSTRAINT group_mapping_scope_shape CHECK (
    (scope_type = 'platform' AND scope_id IS NULL)
    OR (scope_type <> 'platform' AND scope_id IS NOT NULL)
  )
);

CREATE TABLE role_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_idp_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('R1', 'R2', 'R3', 'R4', 'R5', 'R6')),
  scope_type text NOT NULL CHECK (scope_type IN ('platform', 'domain', 'instance')),
  scope_id text,
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CONSTRAINT role_binding_unique UNIQUE (subject_idp_id, role, scope_type, scope_id),
  CONSTRAINT role_binding_scope_shape CHECK (
    (scope_type = 'platform' AND scope_id IS NULL)
    OR (scope_type <> 'platform' AND scope_id IS NOT NULL)
  )
);

CREATE TABLE entitlement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_idp_id text NOT NULL,
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  product_role text NOT NULL,
  source text NOT NULL CHECK (source IN ('group', 'direct')),
  sync_state text NOT NULL CHECK (sync_state IN ('applied', 'pending', 'edge_only', 'unsupported')),
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlement_unique UNIQUE (subject_idp_id, instance_id, product_role)
);

CREATE INDEX entitlement_subject_idx ON entitlement (subject_idp_id);

CREATE TABLE access_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_idp_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('entitlement', 'membership', 'instance_param')),
  target text NOT NULL,
  justification text NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'approved', 'rejected', 'expired')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX access_request_state_idx ON access_request (state, created_at DESC);

CREATE TABLE sync_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  changes integer NOT NULL DEFAULT 0,
  p95_latency_ms integer,
  errors integer NOT NULL DEFAULT 0,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
