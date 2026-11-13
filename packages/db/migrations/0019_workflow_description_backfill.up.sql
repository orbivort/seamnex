-- 0019 — the create path stored an empty string for "no description".
--
-- `WorkflowSchema` requires a non-empty description when one is present, so a single `''` row made
-- `GET /workflows` fail its own response schema — a 500 for the whole page, not for that row. The
-- write path now stores NULL (`PostgresWorkflowService` normalises on read as well), and this
-- backfill repairs the rows written before it.

UPDATE workflow
   SET description = NULL
 WHERE description IS NOT NULL
   AND btrim(description) = '';
