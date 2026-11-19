import { useMe } from '@seamnex/api-client';

/**
 * FR-2.14 — `verifiedBy` names the person who recorded the review.
 *
 * The API resolves a display name from the identity mirror when it writes the record, but an entry
 * verified before that (or by a service account with no mirror row) can still carry a subject id.
 * A UUID on the receipt reads as a defect to the operator who just pressed the button, so the one
 * identity this screen can name — the signed-in user — is resolved here; everything else is shown
 * exactly as recorded rather than guessed at.
 */
export function useVerifierLabel(verifiedBy: string): string {
  const me = useMe();
  return me.data !== undefined && me.data.id === verifiedBy ? me.data.displayName : verifiedBy;
}
