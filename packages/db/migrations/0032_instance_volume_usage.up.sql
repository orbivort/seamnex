-- 0032 — a volume's usage is measured by the platform, so the instance screen can show a real
-- "used / quota" and FR-1.9's per-volume disk limit can be watched instead of asserted
-- (FR-1.9, FR-1.12, FR-2.7, AC-13).
--
-- The limit is **soft** by design: the daemon's `local` volume driver has no quota option, and hard
-- enforcement needs XFS project quotas on the host, which is design assumption DA-2 and may be
-- invalid on a given host. What the platform must not do is claim a figure it never measured — an
-- absent `used_mb` rendered as `0 B / 20 GB` reads as "empty", not as "unknown".
--
-- `instance_volume` rows themselves are written by M05 from the volumes the daemon actually created
-- (the Compose project prefixes every name), which is what makes `quota_mb` meaningful and what the
-- backup runner archives.
ALTER TABLE instance_volume
  ADD COLUMN used_mb integer NOT NULL DEFAULT 0,
  ADD COLUMN sampled_at timestamptz,
  ADD CONSTRAINT instance_volume_used_mb_nonnegative CHECK (used_mb >= 0);

COMMENT ON COLUMN instance_volume.used_mb IS
  'Last measured size of the volume in MiB (FR-1.9). Written by the status sampler through M05; 0 until the first sample is taken.';
COMMENT ON COLUMN instance_volume.sampled_at IS
  'When used_mb was measured. NULL means the volume has not been sampled since it was registered.';
