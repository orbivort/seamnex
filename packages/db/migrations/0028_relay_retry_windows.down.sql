-- Removing the table only loses back-off state: the next pass retries what was deferred, which is
-- exactly what a restart did before this migration existed.
DROP TABLE relay_retry_window;
