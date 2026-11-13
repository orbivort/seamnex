-- 0020 — the directory mirror can say when an account was created and which groups it belongs to.
--
-- Both gaps were visible on `/admin/users` as wrong data rather than as an error:
--
--   * `idp_user` had no creation time, so the API fell back to `updated_at` and the evidence screen
--     labelled "Created" printed the last time the row changed: one sync cycle (or one disable)
--     re-dated every account on the page.
--   * membership was read from the provider, used to derive `role_binding`, and then discarded.
--     Nothing could answer "which groups is this person in", so `GET /admin/users` returned
--     `groups: []` for every account and the Groups column was permanently blank.
--
-- Membership is mirrored state, rewritten by the sync worker like `idp_user` and `idp_group`, and
-- carries no mapping decision: `group_mapping` stays the durable table (invariant 10).

ALTER TABLE idp_user ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE idp_group_member (
  group_idp_id text NOT NULL REFERENCES idp_group (idp_id) ON DELETE CASCADE,
  subject_idp_id text NOT NULL REFERENCES idp_user (idp_id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idp_group_member_pkey PRIMARY KEY (group_idp_id, subject_idp_id)
);

-- The read that matters: every group of one subject (`GET /admin/users/:id`).
CREATE INDEX idp_group_member_subject_idx ON idp_group_member (subject_idp_id);

-- New tables are append-only by default (migration 0010). The mirror is reconciled by difference,
-- so the application and the sync role both need UPDATE/DELETE on this one, explicitly.
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_group_member TO seamnex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON idp_group_member TO seamnex_sync;
