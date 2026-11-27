-- Reverses 0039. Dropping the table restores the pre-migration state: no allow-list existed, and
-- every enforcement point falls back to "no revision, no restriction" only if the code is reverted
-- as well — which is what a down migration means.
DROP TABLE IF EXISTS trusted_registry_revision;
