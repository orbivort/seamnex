-- 0024 — restore the legacy-only key grammar.
--
-- This fails while a composed key is stored, and that refusal is the point: rolling the grammar back
-- without renaming the rows would leave a database the running build cannot describe. Rename the
-- rows first (ADR-BE-20 phase 2, in reverse), which is also what the API needs before it can project
-- a legacy tree again.

ALTER TABLE catalog_entry DROP CONSTRAINT IF EXISTS catalog_entry_key_check;

ALTER TABLE catalog_entry
  ADD CONSTRAINT catalog_entry_key_check CHECK (key ~ '^D[1-9][0-9]{0,2}$');
