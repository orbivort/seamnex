-- 0026 — ADR-BE-22 security remediation: the credential's owner invariant and a failure counter.
--
-- Two gaps closed here, both found by the ADR-BE-22 security review (see the ADR §Implementation
-- status):
--
--   * `0025` added `product_account` to the `secret.scope` CHECK, but nothing tied the secret to the
--     mapping it belongs to: `secret.owner_id` is free text and `open()` takes no scope, so the
--     scope was a naming convention rather than an invariant. The reviewer decision that the
--     credential is "filed under the mapping row's id, never under the instance" needs an enforcer.
--
--     A DEFERRED constraint trigger is the only shape that works: provisioning writes the secret
--     *before* the mapping row (the mapping's NOT NULL `secret_ref` needs the id it returns), so an
--     immediate check would reject the only correct write order. Deferring to COMMIT judges the two
--     rows together, which is what "one transaction, one decision" means here.
--
--   * A credential the product rejects is retried on every launch, which walks a person into the
--     product's brute-force lock (20 failures → 30 minutes, ADR-BE-22 §Trade-offs). A counter lets
--     the relay stop after a bounded number and lets the rotation pass recover the account, instead
--     of a failed credential producing one failed product login per click until the lock trips.

CREATE OR REPLACE FUNCTION seamnex_product_account_secret_owner() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM product_account WHERE id::text = NEW.owner_id) THEN
    RAISE EXCEPTION
      'a product_account secret must be filed under a product_account id, not %', NEW.owner_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER secret_product_account_owner
  AFTER INSERT OR UPDATE OF scope, owner_id ON secret
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.scope = 'product_account')
  EXECUTE FUNCTION seamnex_product_account_secret_owner();

-- Consecutive `credential_rejected` outcomes for this mapping, reset by a successful sign-in or a
-- successful rotation. The relay uses it as a circuit breaker; the sweep uses the resulting
-- `failed` state as the recovery trigger.
ALTER TABLE product_account
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0
    CONSTRAINT product_account_failures_nonnegative CHECK (consecutive_failures >= 0);
