import type { Capability, PlatformRole, PlatformSettings } from '@seamnex/domain';

export const ACCESS_CONTROL_SERVICE = Symbol('seamnex.m09.access-control');
export const MACHINE_CLIENT_SERVICE = Symbol('seamnex.m09.machine-client');

/** Owns role_binding, policy_version, settings, machine_client. Compiles at boot, enforces per request. */
export interface AccessControlService {
  /**
   * The highest active role bound to the subject, or `R5` when nothing is bound.
   *
   * The PDP evaluates the live grant set; this lookup remains the projection helper (`GET /me`)
   * and the fallback for a session whose subject has no binding.
   */
  roleFor(subjectIdpId: string): Promise<PlatformRole>;
  /** All active bindings for a subject, for `GET /me` and for scope resolution. */
  grantsFor(subjectIdpId: string): Promise<
    {
      role: PlatformRole;
      scopeType: 'platform' | 'domain' | 'instance';
      scopeId: string | null;
      expiresAt: string | null;
    }[]
  >;
  /** Settings are read as one document; the ETag is derived from `updated_at` (ADR-BE-09 D2). */
  settings(): Promise<{ settings: PlatformSettings; etag: string }>;
  putSettings(
    values: Record<string, number>,
    expectedEtag: string | undefined,
    actorId: string,
  ): Promise<{ settings: PlatformSettings; etag: string }>;
  /** Compiles `CAPABILITY_MATRIX` into `policy_version` and activates it (ADR-BE-05). */
  compilePolicy(): Promise<{ version: number }>;
}

export type MachinePrincipal = {
  readonly id: string;
  readonly name: string;
  /** Capabilities the client may use; resolved from its closed scope name. */
  readonly scopes: readonly Capability[];
};

/** Bearer-token authentication for machine clients (deliverable 3.4). */
export interface MachineClientAuthenticator {
  authenticate(token: string): Promise<MachinePrincipal | null>;
}
