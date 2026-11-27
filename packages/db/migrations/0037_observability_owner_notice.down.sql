-- Reverses 0037. The columns are evidence about notices already sent; the notices themselves stay in
-- `notification`, so dropping the markers loses only the ability to skip a re-announcement.
DROP INDEX IF EXISTS break_glass_session_unannounced_idx;

ALTER TABLE break_glass_session
  DROP COLUMN IF EXISTS expiry_notified_at,
  DROP COLUMN IF EXISTS grant_notified_at;

DROP INDEX IF EXISTS notification_recipient_idx;

ALTER TABLE notification
  DROP COLUMN IF EXISTS recipient_address,
  DROP COLUMN IF EXISTS recipient_name;
