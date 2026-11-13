import { readFileSync } from 'node:fs';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { requireAdapters } from '../../common/adapters';
import { AppError } from '../../common/problem/app-error';

export type IdpClientSpec = {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly protocol: 'oidc' | 'saml';
  readonly accessTokenLifespanSeconds: number;
  readonly offlineAccessDisabled: boolean;
  readonly secret: string;
  /**
   * OIDC back-channel logout endpoint, when the product implements one. Without it, revoking a
   * grant ends the platform session and leaves the product session alive until it expires — which
   * is exactly the window "revoked within one cycle" is supposed to close.
   */
  readonly backchannelLogoutUrl?: string;
  /**
   * The ID-token claim a product was configured to require, e.g. EspoCRM's `groups`. Registering
   * the client is not enough: unless the client carries a scope that mints the claim, the token
   * arrives without it and the product's group mapping can never work. Left undefined for products
   * that declare none.
   */
  readonly groupClaim?: string;
};

/**
 * 4D.1 - Keycloak Admin API.
 *
 * The token is cached until 30 s before expiry: one round trip per half-minute rather than one per
 * call, and a rejection is never cached. The platform's own admin client secret comes from config
 * because it is a platform credential, not a product one; product secrets live in M15.
 */
@Injectable()
export class KeycloakAdminClient {
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async upsertClient(spec: IdpClientSpec): Promise<{ clientId: string; created: boolean }> {
    const existing = await this.findClient(spec.clientId);
    const representation = {
      clientId: spec.clientId,
      protocol: spec.protocol === 'saml' ? 'saml' : 'openid-connect',
      enabled: true,
      publicClient: false,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      redirectUris: [...spec.redirectUris],
      webOrigins: [],
      secret: spec.secret,
      attributes: {
        'access.token.lifespan': String(spec.accessTokenLifespanSeconds),
        'offline.access.disabled': String(spec.offlineAccessDisabled),
        ...(spec.backchannelLogoutUrl === undefined
          ? {}
          : {
              'backchannel.logout.url': spec.backchannelLogoutUrl,
              // A logout token is only useful if the session it names must exist: without this,
              // Keycloak accepts a token for an already-ended session and the product answers 200
              // while doing nothing.
              'backchannel.logout.session.required': 'true',
            }),
      },
    };

    if (existing === null) {
      await this.request('POST', '/clients', representation);
      if (spec.groupClaim !== undefined)
        await this.ensureGroupClaimScope(spec.clientId, spec.groupClaim);
      return { clientId: spec.clientId, created: true };
    }
    await this.request('PUT', `/clients/${existing}`, representation);
    if (spec.groupClaim !== undefined)
      await this.ensureGroupClaimScope(spec.clientId, spec.groupClaim);
    return { clientId: spec.clientId, created: false };
  }

  /**
   * 4D.1 — the claim the product was told to expect has to be minted by something.
   *
   * EspoCRM is configured with `oidcGroupClaim: groups` and requests `groups` as an *essential*
   * ID-token claim. The client this platform registers carried only Keycloak's stock scopes
   * (`profile`, `email`, `roles`, …), so the token would arrive without the claim no matter how
   * healthy the rest of the registration looked. The scope is created on first use, given a group
   * membership mapper, and assigned to the client; both steps are idempotent, so a re-registration
   * repairs a client that was created before this existed.
   */
  async ensureGroupClaimScope(clientId: string, scopeName: string): Promise<void> {
    const client = await this.findClient(clientId);
    if (client === null) return;
    const scopeId = await this.ensureScopeWithGroupMapper(scopeName);
    // `PUT` on an existing assignment answers 204 as well, which is what makes this safe to repeat.
    await this.request('PUT', `/clients/${client}/default-client-scopes/${scopeId}`);
  }

  private async ensureScopeWithGroupMapper(scopeName: string): Promise<string> {
    const existing = await this.findScope(scopeName);
    if (existing !== null) return existing;

    await this.request('POST', '/client-scopes', {
      name: scopeName,
      protocol: 'openid-connect',
      attributes: { 'include.in.token.scope': 'true', 'display.on.consent.screen': 'false' },
    });
    const created = await this.findScope(scopeName);
    if (created === null) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `Keycloak did not return the ${scopeName} client scope after creating it.`,
        remediation:
          'Check the realm manually; the product will not receive the claim without the scope.',
      });
    }
    await this.request('POST', `/client-scopes/${created}/protocol-mappers/models`, {
      name: scopeName,
      protocol: 'openid-connect',
      protocolMapper: 'oidc-group-membership-mapper',
      config: {
        'claim.name': scopeName,
        'full.path': 'true',
        'id.token.claim': 'true',
        'access.token.claim': 'true',
        'userinfo.token.claim': 'true',
        'jsonType.label': 'String',
      },
    });
    return created;
  }

  private async findScope(scopeName: string): Promise<string | null> {
    const scopes = await this.adminJson<{ id: string; name: string }[]>('/client-scopes');
    return scopes.find((scope) => scope.name === scopeName)?.id ?? null;
  }

  async deleteClient(clientId: string): Promise<void> {
    const existing = await this.findClient(clientId);
    if (existing !== null) await this.request('DELETE', `/clients/${existing}`);
  }

  /**
   * 4C.3: the realm document as platform state. `GET /admin/realms/{realm}` is the supported export
   * (the console's "partial export" is the same call with options), so a backup carries the realm
   * rather than a placeholder that reads like one.
   */
  async exportRealm(): Promise<Record<string, unknown>> {
    const response = await this.request('GET', '');
    return (await response.json()) as Record<string, unknown>;
  }

  /** The restore gate's identity check: an admin token proves the realm answers. */
  async realmReachable(): Promise<boolean> {
    try {
      await this.token();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A JSON read on the realm, for callers that are not provisioning a client — the directory
   * mirror (4D) being the one that matters. Kept here so the token cache, the timeout and the
   * `ADAPTER_UNAVAILABLE` translation are not re-implemented per caller.
   */
  async adminJson<T>(path: string): Promise<T> {
    const response = await this.request('GET', path);
    return (await response.json()) as T;
  }

  /**
   * FR-4.4 — the account's `enabled` flag in the realm.
   *
   * `PUT /users/{id}` with a partial representation only touches the fields it carries, so this is
   * a targeted write rather than a read-modify-write of the whole user. Requires `manage-users` on
   * the platform admin client; without it Keycloak answers 403 and `request` translates that to
   * `ADAPTER_UNAVAILABLE`, which is the honest outcome: the account is still usable in products.
   */
  async setUserEnabled(userId: string, enabled: boolean): Promise<void> {
    await this.request('PUT', `/users/${encodeURIComponent(userId)}`, { enabled });
  }

  private async findClient(clientId: string): Promise<string | null> {
    const response = await this.request('GET', `/clients?clientId=${encodeURIComponent(clientId)}`);
    const rows = (await response.json()) as { id: string; clientId: string }[];
    return rows.find((row) => row.clientId === clientId)?.id ?? null;
  }

  private async token(): Promise<string> {
    if (this.cached !== undefined && this.cached.expiresAt > Date.now()) return this.cached.token;
    requireAdapters(this.config, 'keycloak');
    const secret = this.adminSecret();
    if (secret === undefined) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: 'No Keycloak admin client secret is configured.',
        remediation:
          'Set SEAMNEX_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE (a file path, never an inline secret); product identity cannot be provisioned without it.',
      });
    }
    const response = await this.send(
      'admin token',
      `${this.config.SEAMNEX_KEYCLOAK_ADMIN_URL}/realms/${this.config.SEAMNEX_KEYCLOAK_REALM}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.config.SEAMNEX_KEYCLOAK_ADMIN_CLIENT_ID,
          client_secret: secret,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `Keycloak refused the admin token (${response.status}).`,
        remediation: 'Check the admin client, its secret and the realm name.',
      });
    }
    const payload = (await response.json()) as { access_token: string; expires_in: number };
    this.cached = {
      token: payload.access_token,
      expiresAt: Date.now() + Math.max(30, payload.expires_in - 30) * 1_000,
    };
    return this.cached.token;
  }

  /** The admin secret is a file path, never an inline value, so it can be mounted and rotated. */
  private adminSecret(): string | undefined {
    const path = this.config.SEAMNEX_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE;
    if (path.length === 0) return undefined;
    try {
      return readFileSync(path, 'utf8').trim();
    } catch {
      return undefined;
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await this.send(
      `${method} ${path}`,
      `${this.config.SEAMNEX_KEYCLOAK_ADMIN_URL}/admin/realms/${this.config.SEAMNEX_KEYCLOAK_REALM}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${await this.token()}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `Keycloak ${method} ${path} answered ${response.status}.`,
        remediation: 'The identity change was not applied; retry after checking the admin client.',
      });
    }
    return response;
  }

  /**
   * A transport failure is not an HTTP answer.
   *
   * `fetch` rejects with `fetch failed` when the provider is down, and that string was what reached
   * `sync_run.detail.errors` while the request itself surfaced as an anonymous 500: neither the
   * evidence screen nor the runbook's "read the run's errors" step could name the cause. Naming the
   * call that failed turns it into an `ADAPTER_UNAVAILABLE` an operator can act on.
   */
  private async send(what: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `The identity provider did not answer the ${what} request (${
          error instanceof Error ? error.message : String(error)
        }).`,
        remediation:
          'Check that the identity provider is running and reachable from the control plane, then retry the change.',
        cause: error,
      });
    }
  }
}
