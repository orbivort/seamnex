-- Reverses 0031. Reviews recorded after the migration lose their upstream reference and note; the
-- reviewer and date remain, so the row stays cleared under the old schema. That is the rollback
-- consequence recorded in ADR-BE-25: evidence is discarded, the decision is not.
ALTER TABLE license_record
  DROP CONSTRAINT IF EXISTS license_record_review_evidence;

ALTER TABLE license_record
  DROP COLUMN IF EXISTS review_note,
  DROP COLUMN IF EXISTS upstream_ref;
