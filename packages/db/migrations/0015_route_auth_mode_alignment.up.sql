-- 0015 — the route's auth mode is the catalog entry's guarantee class (FR-2.16, invariant 12).
--
-- `materialiseRoute` defaulted `authMode` to `native` whenever the caller passed none, and the
-- deploy pipeline always passes none (`materialiseRoute(id, {}, actor)`). Every route therefore
-- claimed native sign-in, whatever the entry said. One wrong column produced two visible defects:
--
--   * the portal tile read the route, so a proxy-gate product was presented as single sign-on
--     while its launch dialog asked for a product password;
--   * database invariant 12 rejects `sync_state = 'unsupported'` unless the route's `auth_mode` is
--     `fa_gate`, and the identity sync derives that state from the guarantee class. The insert
--     therefore violated the trigger, the whole entitlement statement rolled back, and every
--     newly deployed product stayed absent from the launcher for every user — the failure was one
--     error line in `sync_run.detail`, not a missing tile with a reason.
--
-- `apps/api` now inherits the class and refuses an explicit contradiction. This repairs the rows
-- that are already deployed. Deleted instances keep their historical route unchanged: the ledger
-- records what was, and rewriting it would make the audit trail disagree with itself.

UPDATE instance_route r
   SET auth_mode = c.guarantee_class,
       updated_at = now()
  FROM instance i
  JOIN catalog_entry c ON c.key = i.entry_key
 WHERE r.instance_id = i.id
   AND i.deleted_at IS NULL
   AND r.auth_mode IS DISTINCT FROM c.guarantee_class;

-- The edge projection is rebuilt from `instance_route` on the next API start (`projectAll`), or
-- immediately for one instance through the gate/lifecycle path. No Traefik file is edited here:
-- the database stays the authority and the files remain a projection of it.
