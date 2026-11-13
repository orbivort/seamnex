-- Exact inverse of 0026_sign_in_relay_hardening.up.sql.
--
-- The counter is dropped with the column. The trigger goes before the function it calls; the
-- function is not shared, so leaving it behind would be dead code the next migration has to reason
-- about.

ALTER TABLE product_account DROP CONSTRAINT IF EXISTS product_account_failures_nonnegative;

ALTER TABLE product_account DROP COLUMN IF EXISTS consecutive_failures;

DROP TRIGGER IF EXISTS secret_product_account_owner ON secret;

DROP FUNCTION IF EXISTS seamnex_product_account_secret_owner();
