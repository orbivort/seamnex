import type { Queryable } from '@seamnex/db';
import type { IntegrationCheck, InstanceRoute } from '@seamnex/domain';

export const INTEGRATION_SERVICE = Symbol('seamnex.m07.integration');

export type RouteInput = {
  readonly host?: string;
  readonly pathPrefix?: string | null;
  readonly publishModel?: 'subdomain' | 'subpath';
  readonly authMode?: 'native' | 'fa_header' | 'fa_delegated' | 'fa_gate';
  readonly published?: boolean;
};

export type AdapterSummary = {
  readonly adapter: 'oidc' | 'saml' | 'fa_header' | 'fa_delegated';
  readonly propagatesGroupRoles: boolean;
  readonly revokesProductSessions: boolean;
  readonly syncState: 'applied' | 'unsupported';
};

/**
 * Whether the IdP is a member of the instance network the product lives on, under the alias the
 * product is configured with. Attachments are transient Docker state, so this is asked (and
 * repaired) rather than assumed.
 */
export type IdentityAttachment = {
  readonly ok: boolean;
  readonly network: string;
  readonly detail: string;
};

/** Owns idp_client, instance_route, integration_check, integration_metadata. */
export interface IntegrationService {
  checks(instanceId: string): Promise<IntegrationCheck[]>;
  route(instanceId: string): Promise<InstanceRoute | null>;
  metadata(instanceId: string): Promise<Record<string, unknown> | null>;
  /** 4D.1 — registers the product's identity client (secret in M15). */
  registerIdentity(
    instanceId: string,
    actorId: string,
  ): Promise<{ clientId: string; adapter: AdapterSummary }>;
  /** 4D.2 — writes the route row and the edge projection; host uniqueness is a database index. */
  materialiseRoute(instanceId: string, input: RouteInput, actorId: string): Promise<InstanceRoute>;
  /**
   * 4D.5 — the five checks `ready` depends on. `ready` is the verdict the executor needs, and
   * `blocking` names what failed so a deploy can refuse with a reason. M07 records the checks but
   * never writes `instance`: that table belongs to M05, and a module that owns a table is the only
   * thing allowed to move its state.
   */
  runChecks(
    instanceId: string,
  ): Promise<{ checks: IntegrationCheck[]; ready: boolean; blocking: string[] }>;
  /**
   * ADR-BE-22 — records one check verdict through the module that owns `integration_check`.
   *
   * It exists because the relay writes on every launch and the table is a diagnostic history, not a
   * log: the implementation stores a row only when the verdict changes or the previous one is an
   * hour old, so a working relay does not add a row per open.
   */
  recordCheck(
    instanceId: string,
    check: IntegrationCheck['check'],
    ok: boolean,
    detail: string,
  ): Promise<void>;
  /** Re-projects every route after a gate change or at boot. */
  projectAll(): Promise<number>;
  /**
   * Owns `instance_route`. The restore gate is one UPDATE across every route, and it must commit
   * with the restore row that justifies it — hence the caller's transaction.
   *
   * M16 used to run this UPDATE itself, which the boundary test could not see: it only knows "this
   * module may name this table", so a foreign write looked exactly like a legitimate read.
   */
  setAllRoutesGated(tx: Queryable, gated: boolean): Promise<void>;
  /**
   * 4D.1 — makes the IdP a member of the instance network, under the alias the product uses.
   * Idempotent, and returns the outcome instead of only logging it.
   */
  ensureIdentityAttachment(instanceId: string): Promise<IdentityAttachment>;
  /**
   * The scheduler's repair pass: re-applies the attachment for every live instance that has an
   * identity client, records a failed `sso_login` check when it cannot, and re-verifies the login
   * leg once the recorded evidence leaves the freshness window.
   */
  reconcileIdentityNetworks(): Promise<{ instances: number; failed: number; verified: number }>;
  /** Re-runs only the login leg and records it. Used by the periodic pass. */
  verifyIdentity(instanceId: string): Promise<{ ok: boolean; detail: string }>;
}
