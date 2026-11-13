-- The collapsed duplicates are not restored: the audit chain holds the earlier decisions, and a
-- rollback must not resurrect an authority an administrator has already replaced.
DROP INDEX IF EXISTS group_mapping_group_unique;
