-- 0034 — the compose policy computed its evidence and threw it away (FR-1.20, NFR-4.15, AC-33).
--
-- `evaluateCompose()` returns the violations it found and the substitutions it made, and
-- `resolve()` dropped both: `source_resolution` recorded a verdict with nothing behind it, and a
-- blocked attempt recorded nothing at all because the refusal was thrown before the row was
-- written. Two consequences, both compliance defects:
--
--   - "the platform operates on a platform-owned copy with the patch recorded as a diff" had no
--     record of the diff. The design already promises it here — §10.1 step 5 and §11.5 both say the
--     `ports:` → `expose:` substitution "is recorded in `source_resolution.patch_diff`" — so this
--     column implements the documented model rather than changing it.
--   - a policy exception could not cite what it was waiving, so the approver decided on a rule name
--     alone. A blocked attempt is now recorded with its violations, which is what the exception
--     request reads. Server-derived evidence, not client text.
--
-- Defaults are empty arrays rather than `{}` because both are lists; a reader that finds `[]` knows
-- the policy ran and found nothing, which is different from a nullable column's "never recorded".
ALTER TABLE source_resolution
  ADD COLUMN patch_diff jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN policy_violations jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN source_resolution.patch_diff IS
  'Substitutions the platform applied to the platform-owned copy, as [{path, from, to}] (FR-1.19, FR-1.20, design §11.5). The upstream file is never modified.';
COMMENT ON COLUMN source_resolution.policy_violations IS
  'Policy violations observed on this attempt, as [{rule, service, detail}]. Recorded for a blocked attempt too, so a refused deployment is evidence rather than a lost event (NFR-4.15, AC-33).';
