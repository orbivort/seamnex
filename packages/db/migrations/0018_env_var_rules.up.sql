-- 0018 — an environment declaration that can be enforced, not only read (AD-09, FR-1.24, AC-06).
--
-- A deployment of D11 (Metabase) failed after its full 20-minute `verify` window because
-- `MB_ENCRYPTION_SECRET_KEY` was 12 characters: Metabase requires 16 and aborts before Jetty binds,
-- so the readiness probe never answered. Nothing in the platform was wrong except one thing — the
-- declaration said "64 hexadecimal characters (`openssl rand -hex 32`)" in a sentence, and no code
-- ever read it. The wizard accepted the value, the API stored it, the renderer injected it, and the
-- JVM refused it.
--
-- `validation_rule` is the enforceable half of that sentence: `minLength`, `maxLength`, `pattern`,
-- `patternDescription` and `disallow`, projected from `catalog/env/<KEY>.json` by
-- `POST /catalog/reload` exactly like the rest of the declaration. It is `jsonb` rather than five
-- columns because it is a copied declaration, not a queryable fact: nothing filters or joins on a
-- minimum length, and a future rule kind (a numeric range, a CIDR) must not need a migration.
--
-- `NULL` is the honest value for every row projected before the file carried a rule, and it means
-- "the declaration makes no enforceable claim" — not "any value is valid".
ALTER TABLE env_schema_var
  ADD COLUMN validation_rule jsonb;

ALTER TABLE env_schema_var
  ADD CONSTRAINT env_schema_var_validation_rule_object
  CHECK (validation_rule IS NULL OR jsonb_typeof(validation_rule) = 'object');

COMMENT ON COLUMN env_schema_var.validation_rule IS
  'Machine-checkable rule from catalog/env/<KEY>.json (minLength, maxLength, pattern, patternDescription, disallow). Enforced by the resolver, so the preview, the deploy request and PUT /instances/:id/env agree.';
