-- 0042 — S-2: lowering the native floor is a recorded owner decision.
--
-- The floor was `NATIVE_FLOOR_DEPLOYMENTS = 6` inside a React page, so nothing could enforce it and
-- nothing could record that somebody accepted fewer native deployments. S-2 permits the lower floor
-- "only by a recorded owner decision — never by re-baselining at P1", so the record is the control:
-- a row names who lowered it, to what, and why, and the posture payload serves it beside the counts.
--
-- Append-only like the other two revision tables: raising the floor back to the default is a new row
-- with `floor = 6`, not a deletion of the decision that was taken.

CREATE TABLE native_floor_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 0 is expressible (nothing native yet); above the 12-deployment baseline is not a decision, it is
  -- a typo, and the CHECK refuses it at the boundary that can still name the problem.
  floor integer NOT NULL,
  reason text NOT NULL,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT native_floor_decision_floor_range CHECK (floor >= 0 AND floor <= 12),
  -- The same floor the break-glass and exception requests use: a decision nobody can read back is
  -- indistinguishable from a silent re-baseline.
  CONSTRAINT native_floor_decision_reason_meaningful CHECK (char_length(btrim(reason)) >= 20)
);

CREATE INDEX native_floor_decision_latest_idx
  ON native_floor_decision (recorded_at DESC);

GRANT SELECT, INSERT ON native_floor_decision TO seamnex_app;

COMMENT ON TABLE native_floor_decision IS
  'S-2 recorded decisions that lower the per-deployment native SSO floor.';
