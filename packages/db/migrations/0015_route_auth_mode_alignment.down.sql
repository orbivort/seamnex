-- Reverses 0015 — deliberately not by restoring the previous values.
--
-- The rows this migration rewrote were wrong: they claimed `native` for entries whose reviewed
-- guarantee class is `fa_gate` or `fa_header`. Putting that back would reintroduce a tile that
-- mislabels the sign-in path and an identity sync that fails invariant 12 on every cycle. A
-- rollback of the deploy code restores the old default on its own; the data it wrote is not worth
-- keeping.
SELECT 1;
