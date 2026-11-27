-- Reverses 0040. The retained evidence goes with it: a down migration for a table whose whole
-- purpose is retention cannot preserve the reports it was holding.
DROP TABLE IF EXISTS image_scan_result;
