-- 0021 — a directory group carries one durable mapping, and the schema says so.
--
-- `group_mapping_unique` was `(group_idp_id, role, scope_type, scope_id)`: the tuple an
-- `INSERT ... ON CONFLICT` upserts, not the invariant the product states — the console prints
-- "each group carries at most one durable platform mapping" on `/admin/groups`. Changing a
-- mapping therefore appended a second row rather than moving the first one, and because the read
-- returns one mapping per group, the operator saw the old role while the directory held both
-- authorities. The write path is fixed in the same change (delete, then insert); this index is
-- what stops any other writer from reintroducing the shape.
--
-- The duplicate rows the old constraint allowed are collapsed first, keeping the most recent
-- decision — it is the one an administrator last saved. Nothing else is rewritten: the audit
-- chain still records every earlier decision, which is where history belongs (invariant 6).

DELETE FROM group_mapping older
 USING group_mapping newer
 WHERE older.group_idp_id = newer.group_idp_id
   AND (older.created_at, older.id) < (newer.created_at, newer.id);

CREATE UNIQUE INDEX group_mapping_group_unique ON group_mapping (group_idp_id);
