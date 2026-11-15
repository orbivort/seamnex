-- 0031 — a licence review is evidence, so reviewer, date and reference stand or fall together
-- (FR-1.14, AC-44, ADR-BE-25).
--
-- `reviewed_by` and `reviewed_at` were independent nullable columns: the schema allowed a sign-off
-- date with no signer, which is the one combination a review must never have. `upstream_ref` is
-- added here because a review that cannot be checked against the upstream LICENSE file (or the
-- commercial contract) is an assertion, not evidence.
--
-- Order matters: clear the partial sign-offs *before* the CHECK is added, otherwise the constraint
-- cannot be validated. A date without a reviewer is not evidence, so the row returns to
-- `review_required` and must be reviewed again.
ALTER TABLE license_record
  ADD COLUMN upstream_ref text,
  ADD COLUMN review_note text;

UPDATE license_record
   SET reviewed_by = NULL,
       reviewed_at = NULL
 WHERE (reviewed_by IS NULL) <> (reviewed_at IS NULL);

-- Sign-offs recorded before this migration have no reference to point at. They are preserved (the
-- reviewer and date are still a real human decision) with an explicit placeholder rather than a
-- fabricated URL; the register renders it as text, not a link. New reviews must supply a real one.
UPDATE license_record
   SET upstream_ref = 'Recorded before migration 0031 (no reference captured)'
 WHERE reviewed_at IS NOT NULL
   AND upstream_ref IS NULL;

ALTER TABLE license_record
  ADD CONSTRAINT license_record_review_evidence CHECK (
    (reviewed_by IS NULL AND reviewed_at IS NULL AND upstream_ref IS NULL)
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND upstream_ref IS NOT NULL)
  );

COMMENT ON COLUMN license_record.upstream_ref IS
  'The artefact the review was checked against: the upstream LICENSE URL or the commercial contract id. Required for a cleared row (ADR-BE-25).';
COMMENT ON COLUMN license_record.review_note IS
  'Reviewer note. Kept out of the audit detail, which records only the note length.';
