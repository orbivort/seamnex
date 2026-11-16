-- Reverses 0038. The endpoint is still registered at the identity provider; dropping the column only
-- loses the platform's own record of it, so sign-out falls back to listing the product as residual.
ALTER TABLE idp_client
  DROP COLUMN IF EXISTS backchannel_logout_url;
