-- Reverses 0042. Any lowered floor disappears with the decision that justified it, which is the
-- intended effect: without the record the default (6) is the only defensible value.
DROP TABLE IF EXISTS native_floor_decision;
