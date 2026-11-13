-- 0024 — ADR-BE-20 phase 1: `catalog_entry.key` accepts the composed grammar beside the legacy one.
--
-- This is the expand step, not the rename. Both grammars become valid at once, which is what lets a
-- tree (and a `platform/` asset set) that has already moved to `D01-01` load on a database that still
-- holds `D1` rows, and vice versa. No row is touched here.
--
-- The two grammars are disjoint: the composed form always carries a hyphen, the legacy form never
-- does. A dual-read window is therefore unambiguous — unlike the concatenated alternative (`D0101`),
-- whose strings are valid legacy keys (`D101`).
--
-- Phase 3 narrows this back to the composed form once the thirteen legacy rows are renamed; see the
-- down migration for why that ordering cannot be reversed.
--
-- `catalog_entry_key_check` is the name Postgres generated for the inline CHECK in 0002
-- (`<table>_<column>_check`), so the drop below removes exactly what this migration replaces.

ALTER TABLE catalog_entry DROP CONSTRAINT IF EXISTS catalog_entry_key_check;

ALTER TABLE catalog_entry
  ADD CONSTRAINT catalog_entry_key_check CHECK (
    key ~ '^D[1-9][0-9]{0,2}$'
    OR key ~ '^D(0[1-9]|[1-9][0-9])-(0[1-9]|[1-9][0-9])$'
  );
