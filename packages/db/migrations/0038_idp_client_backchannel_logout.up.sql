-- 0038 — the platform records the back-channel logout endpoint it registered, so sign-out can tell
-- which products the identity provider is able to notify (FR-3.8, AC-35).
--
-- FR-3.8 asks global sign-out to "initiate logout at products supporting single logout". The only
-- channel this platform has for that is Keycloak's back-channel logout: when the IdP session ends,
-- Keycloak posts a logout token to the endpoint registered on the client. A product can declare
-- `slo_supported` and still have no such endpoint, and that distinction was invisible: the value was
-- handed to Keycloak (`backchannelLogoutUrlFor`) and then forgotten, so the sign-out screen listed
-- every entitled product as a residual session while nothing had been asked of the provider.
--
-- Recording the registered URL is what makes the residual list evidence rather than inference: a
-- product is excluded only when it declares support *and* has an endpoint the provider can call.
ALTER TABLE idp_client
  ADD COLUMN backchannel_logout_url text;

COMMENT ON COLUMN idp_client.backchannel_logout_url IS
  'OIDC back-channel logout endpoint registered on this client (FR-3.8). NULL means the identity provider has no way to notify the product, so its session must be reported as residual.';
