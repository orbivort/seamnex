-- 0023 — one live capacity reservation per instance.
--
-- 0007 created `capacity_reservation_live_idx`, which made the read fast but not exclusive. Two
-- concurrent `reserve()` calls each closed the previous hold inside their own transaction and then
-- both inserted: under READ COMMITTED the second call's `UPDATE ... WHERE released_at IS NULL`
-- re-evaluates after the first commits, finds nothing left to close, and adds a second live row.
--
-- Admission sums every live row (`m19-capacity`), so a duplicate double-counts the instance and the
-- host under-admits — a host refusing work it can actually run. Making the partial index UNIQUE puts
-- the invariant in the database instead of in the caller's timing, and costs nothing: the same index
-- still serves `WHERE instance_id = $1 AND released_at IS NULL`.
--
-- `instance_id` is nullable and a platform-level reservation has no instance. The index relies on
-- the default NULLS DISTINCT, so many platform rows stay legal while one live instance row does not.

-- A pre-existing duplicate would make the index creation fail, so close the older ones first. The
-- newest live row per instance is the one admission is already reading; the older rows are the
-- double-count this migration exists to stop.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY instance_id ORDER BY reserved_at DESC, id DESC) AS position
    FROM capacity_reservation
   WHERE released_at IS NULL
     AND instance_id IS NOT NULL
)
UPDATE capacity_reservation reservation
   SET released_at = now()
  FROM ranked
 WHERE reservation.id = ranked.id
   AND ranked.position > 1;

DROP INDEX IF EXISTS capacity_reservation_live_idx;

CREATE UNIQUE INDEX capacity_reservation_live_unique
  ON capacity_reservation (instance_id)
  WHERE released_at IS NULL;
