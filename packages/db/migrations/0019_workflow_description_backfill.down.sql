-- The backfill is not reversible: the empty strings it removes carried no information, and restoring
-- them would reintroduce the read failure it repairs. `down` is a no-op by design.
SELECT 1;
