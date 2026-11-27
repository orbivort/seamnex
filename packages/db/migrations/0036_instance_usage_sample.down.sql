-- Reverses 0036. Samples are derived data: dropping them loses no product state, and the sampler
-- records a fresh row on its next pass.
DELETE FROM settings
 WHERE key IN (
   'capacity_cpu_alert_percent',
   'capacity_memory_alert_percent',
   'capacity_disk_alert_percent'
 )
   AND updated_by = 'migration:0036';

DROP TABLE IF EXISTS instance_usage_sample;
