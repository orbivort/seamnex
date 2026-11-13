-- Exact inverse of 0025_sign_in_relay.up.sql.
--
-- Two deletions are intentional and stated rather than implied:
--
--   * `relay_login` evidence is removed. Those rows answer "did the relay work", a question that no
--     longer has an implementation once this migration is rolled back; keeping them would leave a
--     check type the rebuilt code cannot produce and cannot interpret.
--   * `product_account`-scoped secrets are removed. They are credentials for accounts the relay
--     created, and leaving them behind would keep a platform-held product password in the store
--     after the mechanism that justified it is gone. The product-side accounts themselves are not
--     touched — disabling them is an operator action, not a schema rollback.

DELETE FROM integration_check WHERE check_type = 'relay_login';

ALTER TABLE integration_check DROP CONSTRAINT IF EXISTS integration_check_check_type_check;

ALTER TABLE integration_check
  ADD CONSTRAINT integration_check_check_type_check CHECK (
    check_type IN ('http', 'sso_login', 'dns', 'backup_registered', 'webhook_registered')
  );

DELETE FROM secret WHERE scope = 'product_account';

ALTER TABLE secret DROP CONSTRAINT IF EXISTS secret_scope_check;

ALTER TABLE secret
  ADD CONSTRAINT secret_scope_check CHECK (
    scope IN ('instance', 'idp_client', 'workflow', 'platform')
  );

DROP TABLE IF EXISTS product_account;
