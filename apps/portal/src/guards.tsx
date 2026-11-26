import { createCapabilityGates } from '@seamnex/shell';
import { useSession } from './session';

/**
 * ADR-FE-01 — the portal's route gates, from the shared factory.
 *
 * The portal had no route guard at all: a guest who typed `/entitlements` got the page, its
 * skeleton, and then a 403 from the first request. The console had the gates and the portal did
 * not, so the same policy was enforced in one app and merely attempted in the other.
 *
 * The refusal node is supplied at the call site rather than imported here, so the route keeps using
 * the lazily loaded `ForbiddenPage` instead of pulling it into the entry chunk.
 */
export const portalGates = createCapabilityGates(useSession);
