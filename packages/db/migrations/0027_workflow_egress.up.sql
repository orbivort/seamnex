-- 0027 — workflow egress: a broker token digest per scope, an n8n credential per product.
--
-- Every compiled node used to carry `url: ={{ $json.baseUrl }}/<operation>` and
-- `credentials.httpHeaderAuth.id: ={{ $json.credentialId }}`. Neither expression could resolve:
-- nothing ever put those fields on the item, so n8n asked for the relative `/employees.read` and
-- refused the run. Egress is now one hop through the broker, and these two columns are what makes
-- that hop verifiable:
--
--   * `credential_scope.token_hash` — the broker authenticates the caller by digest, so a dump of
--     this table yields no usable token. Only a digest is ever stored; the plaintext exists once, in
--     the n8n credential that activation creates.
--   * `workflow_version.n8n_credentials` — the n8n credential id per entry key. n8n exposes create
--     and delete but never a mutation, so rotating a token means creating a new row, repointing the
--     workflow and deleting the old one; the ids have to be recorded per version to do that.

ALTER TABLE credential_scope ADD COLUMN token_hash text;

-- Partial: scopes minted before this migration were never handed to n8n and carry no digest, so they
-- must not collide on a shared NULL.
CREATE UNIQUE INDEX credential_scope_token_hash_unique
  ON credential_scope (token_hash)
  WHERE token_hash IS NOT NULL;

ALTER TABLE workflow_version ADD COLUMN n8n_credentials jsonb NOT NULL DEFAULT '{}'::jsonb;
