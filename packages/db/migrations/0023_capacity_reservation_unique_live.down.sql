-- 0023 — restore the non-unique index.
--
-- Reverting the constraint cannot reinstate the duplicate rows the `up` migration released: their
-- `released_at` is now set and the information about which of two live holds was "the real one" no
-- longer exists. The rows are still present, so the capacity board's history is intact — only the
-- double-count is gone. That is the intended direction: this migration removes a defect, it does not
-- move data.

DROP INDEX IF EXISTS capacity_reservation_live_unique;

CREATE INDEX IF NOT EXISTS capacity_reservation_live_idx
  ON capacity_reservation (instance_id)
  WHERE released_at IS NULL;
