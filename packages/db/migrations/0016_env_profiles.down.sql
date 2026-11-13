-- 0016 rollback: remove the seeded profiles, but only the ones nothing depends on.
--
-- `instance.profile_key` has no `ON DELETE` rule, so deleting a profile a deployment used fails on
-- the foreign key. That is the right outcome: the row is part of the answer to "which profile was
-- this instance deployed with", and a rollback must not erase it. Profiles created by an operator
-- (`updated_by <> 'system'`) are never touched.
DELETE FROM env_profile p
 WHERE p.key IN ('production', 'staging')
   AND p.updated_by = 'system'
   AND NOT EXISTS (SELECT 1 FROM instance i WHERE i.profile_key = p.key);
