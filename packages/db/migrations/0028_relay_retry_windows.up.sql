-- 0028 — ADR-BE-22: the relay's retry windows outlive the process.
--
-- Two timers decided how soon the platform would try a product again, and both lived in a `Map`:
--
--   * the six-hour quiet period after an administrator-token bootstrap failed. The ADR's table says
--     it is "read back from the audit chain so a restart does not spend another attempt on a wrong
--     password"; it was not, and it could not be. The chain is append-only by contract and no module
--     may read another module's rows for scheduling, so the window was process-local and a restart
--     spent one more attempt against a product that locks an account after a run of failed sign-ins.
--
--   * the fifteen-minute window that suppresses a repeated `provision_failed` audit row. Restarting
--     cleared it and the same failure re-audited, which read as "the restart changed something".
--
-- One table, one shape: when this key may next be attempted. A window is a fact about the platform's
-- own back-off, not about the product — which is why it is stored rather than inferred from
-- `product_account.updated_at`: a failure before a mapping exists (no adapter, no admin token) has
-- no row to carry a timestamp.
--
-- `subject_idp_id` is the empty string for an instance-wide window: the bootstrap belongs to the
-- deployment, not to a person. The alternative — a nullable column — needs `UNIQUE NULLS NOT
-- DISTINCT` to keep an upsert's conflict target working, and an empty string is the plainer
-- spelling of "not about a person".

CREATE TABLE relay_retry_window (
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  -- '' = the instance itself. Never an IdP subject with an empty claim: the identity sync rejects
  -- a subject it cannot name.
  subject_idp_id text NOT NULL DEFAULT '',
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 64),
  retry_after timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, subject_idp_id, reason)
);

-- Every read is scoped to one instance (the sweep and the bootstrap both know it), and the primary
-- key already leads with `instance_id`, so no secondary index is added.
