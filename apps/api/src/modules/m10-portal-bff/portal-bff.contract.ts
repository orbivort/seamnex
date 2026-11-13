import type { Queryable } from '@seamnex/db';
import type {
  EntitlementResponse,
  LaunchEvent,
  LaunchTarget,
  LaunchTicket,
  LauncherResponse,
  LauncherTile,
  Me,
  PlatformRole,
  RequestableProduct,
  StatusBanner,
} from '@seamnex/domain';

export const PORTAL_BFF_SERVICE = Symbol('seamnex.m10.portal-bff');

/**
 * The session facts `GET /me` reports. Passed from the request context so the profile never
 * recomputes a lifetime the session service already knows (and never invents MFA state).
 */
export type MeSession = {
  readonly roles: readonly PlatformRole[];
  readonly mfaSatisfied: boolean;
  readonly mfaMethod: 'totp' | 'webauthn' | 'none';
  readonly sessionExpiresAt: string;
  readonly groups: readonly string[];
};

/** Owns `entitlement` and the portal projections, plus the Redis session (Phase 3). */
export interface PortalBffService {
  me(subjectIdpId: string, session: MeSession): Promise<Me>;
  entitlements(subjectIdpId: string): Promise<EntitlementResponse>;
  /**
   * Owns `entitlement`. Grants the direct entitlement an approved access request implies, inside
   * the caller's transaction so the grant commits with the decision that caused it.
   *
   * M18 used to `INSERT INTO entitlement` itself: one approval, two owners, and the boundary test
   * could not tell that write from a legitimate read.
   */
  grantDirectEntitlement(
    tx: Queryable,
    input: { readonly subjectIdpId: string; readonly target: string },
  ): Promise<void>;
  /**
   * Grants the deploying subject owner access to an instance the platform has just created.
   *
   * The launcher projects `entitlement`, never `instance`: a product published at the edge with no
   * grant is installed and invisible, and the only way in was a manual approval of an access request
   * nobody could open, because the product was not listed for anyone to request. Deploying is
   * therefore the moment access is created — for the operator who created it, and nobody else.
   *
   * Runs on M10's own connection because the caller (the deploy handler) has no transaction open and
   * because `entitlement` is M10's table. `false` means the instance no longer exists, so the caller
   * can tell "granted" from "the row was gone".
   */
  grantInstanceOwner(instanceId: string, subjectIdpId: string): Promise<boolean>;
  launcher(subjectIdpId: string): Promise<LauncherResponse>;
  launchTarget(subjectIdpId: string, instanceId: string): Promise<LaunchTarget>;
  /**
   * A single-use ticket the edge redeems to plant the session cookie on the product's host. Only
   * meaningful for a forward-auth route; a `native` product opens on its plain URL.
   */
  launchTicket(
    subjectIdpId: string,
    instanceId: string,
    sessionId: string | null,
  ): Promise<LaunchTicket>;
  /**
   * Records that the subject opened a product. The click is the last moment the platform can see:
   * everything after it happens between the browser, the IdP and the product.
   */
  recordLaunch(subjectIdpId: string, instanceId: string): Promise<LaunchEvent>;
  product(subjectIdpId: string, slug: string): Promise<LauncherTile>;
  requestable(subjectIdpId: string): Promise<RequestableProduct[]>;
  statusBanner(): Promise<StatusBanner | null>;
}
