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
   * healthy the rest of the registration looked. The scope is found (or created), made to carry a
   * group-membership mapper, and assigned to the client; every step is idempotent, so a
   * re-registration repairs a client that was created before this existed.
   *
   * Keycloak 26.8.2 made the mapper step permission-sensitive: creating, updating or deleting a
   * protocol mapper on a client *or a client scope* now requires `manage-realm` unless the mapper
   * type is allow-listed for client administrators (the list is empty by default). The platform's
   * admin client holds `manage-clients`, not `manage-realm`, so a scope that has to be created at
   * registration time can no longer be given its mapper — and a client left without it mints ID
   * tokens with no `groups`, which is the claim the product was configured to require. The scope
   * and its mapper are therefore declared in `platform/realm/realm.json` (`groups`), where the
   * realm-as-code CLI owns them; this method reuses what the realm declares and only reports the
   * refusal, precisely, if the realm does not.
   */
  async ensureGroupClaimScope(clientId: string, scopeName: string): Promise<void> {
    const client = await this.findClient(clientId);
    if (client === null) return;
    const scopeId = await this.ensureScopeWithGroupMapper(scopeName);
    // `PUT` on an existing assignment answers 204 as well, which is what makes this safe to repeat.
    await this.request('PUT', `/clients/${client}/default-client-scopes/${scopeId}`);
  }

  private async ensureScopeWithGroupMapper(scopeName: string): Promise<string> {
    let scopeId = await this.findScope(scopeName);

    if (scopeId === null) {
      await this.request('POST', '/client-scopes', {
        name: scopeName,
        protocol: 'openid-connect',
        attributes: { 'include.in.token.scope': 'true', 'display.on.consent.screen': 'false' },
      });
      scopeId = await this.findScope(scopeName);
      if (scopeId === null) {
        throw new AppError({
          code: 'ADAPTER_UNAVAILABLE',
          detail: `Keycloak did not return the ${scopeName} client scope after creating it.`,
          remediation:
            'Check the realm manually; the product will not receive the claim without the scope.',
        });
      }
    }

    if (await this.scopeMintsClaim(scopeId, scopeName)) return scopeId;

    await this.createGroupMapper(scopeId, scopeName);
    return scopeId;
  }

  /** Whether the scope already carries a mapper that writes `claimName` into the token. */
  private async scopeMintsClaim(scopeId: string, claimName: string): Promise<boolean> {
    const mappers = await this.adminJson<{ config?: Record<string, string | undefined> }[]>(
      `/client-scopes/${scopeId}/protocol-mappers/models`,
    );
    return mappers.some((mapper) => mapper.config?.['claim.name'] === claimName);
  }

  /**
   * The write Keycloak 26.8.2 restricted, with the refusal translated into the one instruction that
   * repairs it. A generic `403` reaching the deploy log named neither the cause nor the fix.
   */
  private async createGroupMapper(scopeId: string, scopeName: string): Promise<void> {
    const response = await this.requestResponse(
      'POST',
      `/client-scopes/${scopeId}/protocol-mappers/models`,
      {
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
      },
    );
    if (response.status === 403) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `Keycloak refused the ${scopeName} protocol mapper (403). Since 26.8.2 a protocol mapper on a client scope requires \`manage-realm\`, which the platform admin client does not hold.`,
        remediation: `Declare the ${scopeName} client scope and its oidc-group-membership-mapper in platform/realm/realm.json so realm-as-code owns them, then re-apply with \`pnpm kc:admin\`; the product needs the claim to map groups.`,
      });
    }
    if (!response.ok) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `Keycloak refused the ${scopeName} protocol mapper (${response.status}).`,
        remediation: `Check the realm manually; the product will not receive the ${scopeName} claim without the mapper.`,
      });
    }
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

  /**
   * FR-1.36 — put the exported realm back.
   *
   * Restoring the identity provider's database already carries the realm, so this is the fallback for
   * what a database restore cannot cover: a realm that answered but lost configuration the export
   * holds (clients, scopes, mappers, flows). `POST /admin/realms` creates; a 409 means it is there
   * and the update goes to `PUT /admin/realms/{realm}`. Both are idempotent, so a retry repairs a
   * half-applied import instead of failing on it.
   *
   * It cannot bootstrap a provider whose admin token cannot be obtained — `token()` authenticates
   * against the realm being imported, so a provider with no realm answers nothing here. That case
   * surfaces as `ADAPTER_UNAVAILABLE` with the operator's instruction rather than a silent no-op,
   * because FR-1.36 requires a restore that cannot authenticate to be reported failed.
   *
   * The document carries client secrets, which is why it is written 0600 by the capture stage and
   * why nothing here logs the body or the response.
   */
  async importRealm(document: Record<string, unknown>): Promise<{ created: boolean }> {
    // A 409 is "the realm is already there", which is the state the update path expects, not a
    // refusal: it is the difference between create and converge.
    const created = await this.adminRequest(
      'POST',
      '/realms',
      document,
      'Keycloak refused the realm import',
      [409],
    );
    if (created.status !== 409) return { created: true };
    await this.request('PUT', '', document);
    return { created: false };
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
   * FR-1.36 — drop the cached token so the next check is a real call.
   *
   * A restored realm is a different realm with the same name, and a token minted before the restore
   * can still be inside its lifetime: `realmReachable()` would then answer `true` from the cache
   * without a single request reaching the provider, which is exactly the false evidence the login
   * gate exists to prevent.
   */
  invalidateToken(): void {
    this.cached = undefined;
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

  /**
   * FR-3.8 / AC-35 — ends every session this subject holds in the realm.
   *
   * This is the single logout the platform was missing: ending the provider session is what makes
   * Keycloak post a logout token to each client that registered `backchannel.logout.url`, so the
   * products end their own sessions instead of expiring quietly. "Global sign-out" is exactly the
   * scope of the call — every browser and every product for this subject goes, which is what the
   * user asked the button to do.
   *
   * A 204 is the accepted answer; an unknown user answers 404 and is tolerated, because the honest
   * outcome for "this account no longer exists at the provider" is "there is nothing left to end",
   * not a failed sign-out. A 403 is not tolerated: it means the admin client may not write sessions,
   * and the caller has to say so rather than assume the products were notified.
   */
  async endUserSessions(userId: string): Promise<void> {
    await this.adminRequest(
      'POST',
      `/realms/${this.config.SEAMNEX_KEYCLOAK_REALM}/users/${encodeURIComponent(userId)}/logout`,
      undefined,
      'Keycloak refused to end the user session',
      [404],
    );
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
    return this.adminRequest(
      method,
      `/realms/${this.config.SEAMNEX_KEYCLOAK_REALM}${path}`,
      body,
      `Keycloak ${method} ${path} answered`,
    );
  }

  /**
   * One admin call against `/admin`, and the only place a token is attached.
   *
   * `importRealm` needs the realm *collection* (`/realms`), which the realm-scoped helper cannot
   * express; the two share this method so the timeout, the token cache and the failure translation
   * stay single-valued. `what` is the caller's sentence for a refusal, because "PUT  answered 403" is
   * not something an operator can act on.
   */
  private async adminRequest(
    method: string,
    path: string,
    body?: unknown,
    what = `Keycloak ${method} ${path} answered`,
    tolerate: readonly number[] = [],
  ): Promise<Response> {
    const response = await this.adminCall(method, path, body);
    if (!response.ok && !tolerate.includes(response.status)) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `${what} ${response.status}.`,
        remediation: 'The identity change was not applied; retry after checking the admin client.',
      });
    }
    return response;
  }

  /**
   * A realm-scoped call whose reply is left to the caller.
   *
   * A refusal that means different things per status — a 403 for a permission the release now
   * requires, against a 404 for an unknown client — cannot be translated into one sentence here
   * without saying nothing useful. Takes a path relative to the realm, like `request`.
   */
  private async requestResponse(method: string, path: string, body?: unknown): Promise<Response> {
    return this.adminCall(method, `/realms/${this.config.SEAMNEX_KEYCLOAK_REALM}${path}`, body);
  }

  /** The transport: one authenticated admin call, path absolute from `/admin`. */
  private async adminCall(method: string, path: string, body?: unknown): Promise<Response> {
    return this.send(
      `${method} ${path}`,
      `${this.config.SEAMNEX_KEYCLOAK_ADMIN_URL}/admin${path}`,
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
