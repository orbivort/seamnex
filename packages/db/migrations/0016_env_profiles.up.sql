-- 0016 — the lifecycle profiles every deployment selects (FR-1.24–FR-1.28).
--
-- `instance.profile_key` references `env_profile`, and the deploy wizard refuses to submit without
-- a selection. Nothing created those rows:
--
--   * the development seed stopped seeding them — its own header now says it owns identity tables
--     only, and that "environment profiles ... are owned by POST /catalog/reload"; the reload
--     projects `catalog_entry` and `env_schema_var` and never touches `env_profile`;
--   * no endpoint creates them (design NB-1 records "no profile CRUD endpoint"); `GET
--     /env-profiles` is the only route.
--
-- A fresh database therefore deployed nothing. The wizard's profile `<Select>` rendered with zero
-- options, `profileKey` stayed `''`, and the submit handler returned before issuing a request:
-- "Deploy instance" was a button that did nothing, with no message anywhere on the screen.
--
-- The contract already fixes the two targets (`env_profile.target` CHECK (production | staging)),
-- and the console's own copy names them, so they are reference data like `settings` (0007) and the
-- audit chain root (0009) rather than operator content. `ON CONFLICT DO NOTHING` leaves a host that
-- named its profiles differently exactly as it was.
INSERT INTO env_profile (key, target, updated_by)
VALUES ('production', 'production', 'system'),
       ('staging', 'staging', 'system')
ON CONFLICT (key) DO NOTHING;
