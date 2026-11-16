-- 0037 — a notice has an addressee, and a break-glass session remembers it was announced
-- (FR-4.11, AC-47).
--
-- Two gaps are closed here:
--
--   1. `notification` had no recipient. "The domain owner was told" could only be inferred from a body
--      string, which is not evidence — the module's own doctrine is that a suppressed notice is
--      recorded so "was anyone told?" is answerable. The addressee is now part of the row.
--   2. break-glass notices were found by a ten-minute look-back over `granted_at`/`revoked_at`. A
--      grant whose first evaluation pass ran late was never announced at all. The marker columns let
--      the notifier announce each transition exactly once, whenever it first observes it.
ALTER TABLE notification
  ADD COLUMN recipient_name text,
  ADD COLUMN recipient_address text;

COMMENT ON COLUMN notification.recipient_name IS
  'Who the notice was addressed to (FR-4.11: the domain owner). NULL for platform-wide notices.';
COMMENT ON COLUMN notification.recipient_address IS
  'Mailbox used when the addressee had one on the catalogue entry; NULL when delivery fell back to the configured channels.';

-- A notice addressed to an owner is a different row from an unaddressed platform notice with the same
-- subject; the dedupe lookup filters on this, so one owner is never silenced by another's delivery.
CREATE INDEX notification_recipient_idx ON notification (recipient_name, created_at DESC)
  WHERE recipient_name IS NOT NULL;

ALTER TABLE break_glass_session
  ADD COLUMN grant_notified_at timestamptz,
  ADD COLUMN expiry_notified_at timestamptz;

COMMENT ON COLUMN break_glass_session.grant_notified_at IS
  'When the grant notice for this session was produced (FR-4.11). NULL means not yet announced, not "nothing to announce".';
COMMENT ON COLUMN break_glass_session.expiry_notified_at IS
  'When the expiry notice for this session was produced (FR-4.11).';

-- The evaluator's question is "which transitions have not been announced?", so the index covers that
-- set only rather than the whole history of sessions.
CREATE INDEX break_glass_session_unannounced_idx
  ON break_glass_session (state, expires_at)
  WHERE grant_notified_at IS NULL OR expiry_notified_at IS NULL;
