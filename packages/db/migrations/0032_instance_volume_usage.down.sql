-- Reverses 0032. Measurements are derived data: dropping them loses no product state, and the next
-- deployment or reconfigure registers the volume again.
ALTER TABLE instance_volume
  DROP CONSTRAINT IF EXISTS instance_volume_used_mb_nonnegative;

ALTER TABLE instance_volume
  DROP COLUMN IF EXISTS sampled_at,
  DROP COLUMN IF EXISTS used_mb;
