-- Reverses 0041. The advisory history goes; `patch_record` returns to the shape it had when nothing
-- wrote it.
DROP TABLE IF EXISTS patch_advisory;

ALTER TABLE patch_record
  DROP COLUMN IF EXISTS last_observed_at,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS release_url,
  DROP COLUMN IF EXISTS advisory_url,
  DROP COLUMN IF EXISTS advisory_severity,
  DROP COLUMN IF EXISTS advisory_id;
