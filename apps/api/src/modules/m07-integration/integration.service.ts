import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { IntegrationCheck, InstanceRoute } from '@seamnex/domain';
import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '@seamnex/db';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { SECRETS_SERVICE, type SecretsService } from '../m15-secrets/secrets.contract';
import { DockerEngineClient } from '../../common/docker/docker.client';
import { instanceNetwork } from '../../common/docker/naming';
import { describeProbe, probeProductHttp } from '../../common/exec/http-probe';
import { probeIdpFromNetwork } from '../../common/exec/idp-probe';
import type {
  AdapterSummary,
  IdentityAttachment,
  IntegrationService,
  RouteInput,
} from './integration.contract';
import { KeycloakAdminClient } from '../../common/keycloak/keycloak-admin.client';
import { TraefikRouteWriter } from './traefik.writer';
import {
  backchannelLogoutUrlFor,
  oidcGroupClaimFor,
  oidcSecretVariableFor,
  publicBaseUrl,
  redirectUriFor,
} from './oidc-redirect';
import { SsoProbe, type SsoProbeResult } from './sso.probe';

const CHECK_LABELS: Record<IntegrationCheck['check'], string> = {
  http: 'HTTP response',
  sso_login: 'SSO test login',
  dns: 'DNS and route',
  backup_registered: 'Backup registration',
  webhook_registered: 'Webhook registration',
  // Never "SSO": a relayed password sign-in is evidence the relay works, not evidence of SSO.
  relay_login: 'Relayed sign-in',
};

/** How stale a repeated check verdict may be before it is written again. */
const CHECK_REFRESH_MS = 60 * 60 * 1_000;

/**
 * 4D.3 - adapter class per guarantee class.
 *
 * A forward-auth gate cannot push a role into a product it has no identity integration with, and
 * cannot revoke a session it never issued. Recording that as `unsupported` (inv. 12) is what keeps a
 * gate from being displayed as SSO: the label comes from the guarantee class, and the sync state
 * comes from here.
 */
export function adapterFor(guaranteeClass: string, authMethod: string): AdapterSummary {
  if (authMethod === 'saml') {
    return {
      adapter: 'saml',
      propagatesGroupRoles: true,
      revokesProductSessions: true,
      syncState: 'applied',
    };
  }
  if (guaranteeClass === 'fa_gate') {
    return {
      adapter: 'fa_header',
      propagatesGroupRoles: false,
      revokesProductSessions: false,
      syncState: 'unsupported',
    };
  }
  if (guaranteeClass === 'fa_delegated') {
    return {
      adapter: 'fa_delegated',
      propagatesGroupRoles: false,
      revokesProductSessions: false,
      syncState: 'unsupported',
    };
  }
  if (guaranteeClass === 'fa_header') {
    return {
      adapter: 'fa_header',
      propagatesGroupRoles: false,
      revokesProductSessions: true,
      syncState: 'applied',
    };
  }
  return {
    adapter: 'oidc',
    propagatesGroupRoles: true,
    revokesProductSessions: true,
    syncState: 'applied',
  };
}

/** 4D.1/4D.2/4D.5 — identity client, edge route and post-deploy checks. */
@Injectable()
export class PostgresIntegrationService implements IntegrationService, OnModuleInit {
  private readonly logger = new Logger('m07-integration');

  /**
   * Routes are a projection of instance_route; if the API restarts while Traefik keeps its files,
   * the two can disagree. Re-projecting at boot makes the files match the database again, and it is
   * the one place that runs without a caller.
   */
  async onModuleInit(): Promise<void> {
    await this.projectAll().catch(() => undefined);
  }
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(SECRETS_SERVICE) private readonly secrets: SecretsService,
    @Inject(DockerEngineClient) private readonly docker: DockerEngineClient,
    @Inject(KeycloakAdminClient) private readonly keycloak: KeycloakAdminClient,
    @Inject(TraefikRouteWriter) private readonly traefik: TraefikRouteWriter,
    @Inject(SsoProbe) private readonly ssoProbe: SsoProbe,
  ) {}

  async checks(instanceId: string): Promise<IntegrationCheck[]> {
    const result = await this.pool.query<{
      check_type: IntegrationCheck['check'];
      ok: boolean;
      detail: string | null;
      checked_at: Date;
    }>(
      `SELECT DISTINCT ON (check_type) check_type, ok, detail, checked_at
         FROM integration_check
        WHERE instance_id = $1
        ORDER BY check_type, checked_at DESC`,
      [instanceId],
    );
    return result.rows.map((row) => ({
      check: row.check_type,
      label: CHECK_LABELS[row.check_type] ?? row.check_type,
      ok: row.ok,
      detail: row.detail ?? '',
      checkedAt: row.checked_at.toISOString(),
    }));
  }

  async recordCheck(
    instanceId: string,
    check: IntegrationCheck['check'],
    ok: boolean,
    detail: string,
  ): Promise<void> {
    const previous = await this.pool.query<{ ok: boolean; checked_at: Date }>(
      `SELECT ok, checked_at FROM integration_check
        WHERE instance_id = $1 AND check_type = $2
        ORDER BY checked_at DESC LIMIT 1`,
      [instanceId, check],
    );
    const row = previous.rows[0];
    const stale = row === undefined || Date.now() - row.checked_at.getTime() > CHECK_REFRESH_MS;
    // Same verdict, recent evidence: the row would say nothing the existing one does not.
    if (row !== undefined && row.ok === ok && !stale) return;
    await this.pool.query(
      `INSERT INTO integration_check (instance_id, check_type, ok, detail) VALUES ($1, $2, $3, $4)`,
      [instanceId, check, ok, detail],
    );
  }

  async route(instanceId: string): Promise<InstanceRoute | null> {
    const result = await this.pool.query<{
      host: string;
      path_prefix: string | null;
      publish_model: InstanceRoute['publishModel'];
      tls_mode: InstanceRoute['tlsMode'];
      auth_mode: InstanceRoute['authMode'];
      published: boolean;
      gated: boolean;
    }>(
      `SELECT host, path_prefix, publish_model, tls_mode, auth_mode, published, gated
         FROM instance_route WHERE instance_id = $1`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      host: row.host,
      pathPrefix: row.path_prefix ?? '/',
      publishModel: row.publish_model,
      tlsMode: row.tls_mode,
      authMode: row.auth_mode,
      published: row.published && !row.gated,
    };
  }

  /**
   * The verified facts for one instance (FR-2.14).
   *
   * `integration_metadata` has real columns, not a `payload` document — the previous query selected
   * a column that does not exist and joined on `entry_key`, which is not unique per row, so it
   * neither ran nor answered the question it was asked.
   */
  async metadata(instanceId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<{
      credential_granularity: string;
      session_max_minutes: number | null;
      api_base_url: string | null;
      auth_method: string | null;
      guarantee_class_verified: string | null;
      operation_inventory: unknown;
      event_modes: unknown;
      slo_supported: boolean | null;
      verified_by: string | null;
      verified_at: Date | null;
      next_review_at: Date | null;
    }>(
      `SELECT credential_granularity, session_max_minutes, api_base_url, auth_method,
              guarantee_class_verified, operation_inventory, event_modes, slo_supported,
              verified_by, verified_at, next_review_at
         FROM integration_metadata
        WHERE instance_id = $1`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      credentialGranularity: row.credential_granularity,
      sessionMaxMinutes: row.session_max_minutes,
      apiBaseUrl: row.api_base_url,
      authMethod: row.auth_method,
      guaranteeClassVerified: row.guarantee_class_verified,
      operationInventory: row.operation_inventory,
      eventModes: row.event_modes,
      sloSupported: row.slo_supported,
      verifiedBy: row.verified_by,
      verifiedAt: row.verified_at?.toISOString() ?? null,
      nextReviewAt: row.next_review_at?.toISOString() ?? null,
    };
  }

  async registerIdentity(
    instanceId: string,
    actorId: string,
  ): Promise<{ clientId: string; adapter: AdapterSummary }> {
    const instance = await this.instanceOf(instanceId);
    const adapter = adapterFor(
      String(instance.payload.guaranteeClass ?? 'native'),
      String(instance.payload.authMethod ?? 'oidc'),
    );
    const clientId = `seamnex-${instance.slug}`;
    if (clientId.length > 200) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `The derived client id ${clientId} is longer than Keycloak accepts.`,
        remediation: 'Shorten the instance slug.',
      });
    }
    // The IdP and the product must share one client secret. When the operator has stored it as the
    // product's OIDC secret variable, reuse that value: generating a second one here would register
    // a client the product can never authenticate as, which is a login that fails after the redirect
    // with no hint of why.
    const secretVariable = oidcSecretVariableFor(instance.entryKey);
    const operatorSecret =
      secretVariable === null
        ? null
        : await this.secrets.find('instance', instanceId, secretVariable).catch(() => null);
    const secret =
      operatorSecret === null
        ? randomSecret()
        : await this.secrets.open(operatorSecret.id, `register identity client ${instanceId}`);
    /**
     * A generated secret is stored under the product's own variable name, not only as an
     * `idp_client` secret.
     *
     * The renderer resolves `instance_env_value` and nothing else, so a secret parked in an
     * `idp_client` scope never reaches the container: the client is registered at the IdP with a
     * value the product does not have, the platform's own probe passes (it used its copy), and the
     * product's login fails at the token exchange with `invalid_client` — which it reports as a
     * site-URL problem. Writing it as the declared variable makes the value that was registered the
     * value that is applied.
     */
    const stored =
      operatorSecret ??
      (await this.secrets.put(
        secretVariable === null ? 'idp_client' : 'instance',
        instanceId,
        secretVariable ?? 'client_secret',
        secret,
      ));
    // The browser-facing base URL, not an assumed one: the dev edge serves HTTP on :8020 and the
    // product derives its own redirect URI from the same site URL, so a mismatch here is a login that
    // can never complete.
    const baseUrl = publicBaseUrl(
      this.config.SEAMNEX_PRODUCT_URL_SCHEME,
      instance.host,
      this.config.SEAMNEX_PRODUCT_URL_PORT,
    );
    const protocol = adapter.adapter === 'saml' ? 'saml' : 'oidc';
    const redirectUris = [redirectUriFor({ entryKey: instance.entryKey, protocol, baseUrl })];
    const backchannelLogoutUrl = backchannelLogoutUrlFor(instance.entryKey, baseUrl);
    // The product calls the token, JWKS and userinfo endpoints from its own network. Joining the IdP
    // to that network is the difference between a login that completes and one that fails after the
    // browser has already been redirected back. The result is recorded rather than logged and
    // forgotten: `runChecks` and the scheduler reconcile the same step, and a failure has to reach
    // the instance instead of a warning nobody reads.
    const attachment = await this.ensureIdentityAttachment(instanceId);
    if (!attachment.ok) {
      this.logger.warn(
        `${attachment.detail}; the token exchange will fail until the attachment exists`,
      );
      await this.audit.append({
        action: 'instance.idp_network.unavailable',
        actorType: 'system',
        actorId: 'm07-integration',
        targetType: 'instance',
        targetId: instanceId,
        outcome: 'failure',
        detail: {
          network: instanceNetwork(instance.slug),
          alias: this.config.SEAMNEX_IDP_ALIAS,
          reason: attachment.detail,
        },
      });
    }

    const groupClaim = oidcGroupClaimFor(instance.entryKey);
    const upserted = await this.keycloak
      .upsertClient({
        clientId,
        redirectUris,
        protocol,
        accessTokenLifespanSeconds: 300,
        offlineAccessDisabled: true,
        secret,
        ...(backchannelLogoutUrl === null ? {} : { backchannelLogoutUrl }),
        ...(groupClaim === null ? {} : { groupClaim }),
      })
      .catch(async (error: unknown) => {
        // A host with no admin client for the identity provider cannot provision one, and a
        // deployment must not fail for it: a `native` product authenticates against its own store
        // and is fully usable without an IdP client. Record the gap instead of inventing success
        // (inv. 12), and let the readiness verdict decide what it means for this guarantee class.
        if (!(error instanceof AppError) || error.code !== 'ADAPTER_UNAVAILABLE') throw error;
        await this.audit.append({
          action: 'instance.idp_client.unavailable',
          actorType: 'system',
          actorId: 'm07-integration',
          targetType: 'instance',
          targetId: instanceId,
          outcome: 'failure',
          detail: { clientId, reason: error.detail },
        });
        return { created: false, unsupported: true } as const;
      });

    if ('unsupported' in upserted) {
      return { clientId, adapter: { ...adapter, syncState: 'unsupported' } };
    }

    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      await tx.query(
        `INSERT INTO idp_client
           (instance_id, client_id, client_secret_ref, protocol, redirect_uris, access_token_lifespan_seconds, offline_access_disabled)
         VALUES ($1, $2, $3, $4, $5::text[], 300, true)
         ON CONFLICT (instance_id) DO UPDATE
            SET client_id = EXCLUDED.client_id, client_secret_ref = EXCLUDED.client_secret_ref,
                protocol = EXCLUDED.protocol, redirect_uris = EXCLUDED.redirect_uris,
                access_token_lifespan_seconds = EXCLUDED.access_token_lifespan_seconds,
                offline_access_disabled = EXCLUDED.offline_access_disabled`,
        [instanceId, clientId, stored.id, protocol, redirectUris],
      );
      await this.audit.append(
        {
          action: 'instance.idp_client.registered',
          actorType: 'user',
          actorId,
          targetType: 'instance',
          targetId: instanceId,
          outcome: 'success',
          detail: {
            clientId,
            adapter: adapter.adapter,
            created: upserted.created,
            syncState: adapter.syncState,
            // Which value the client was registered with: the operator's variable, or one the
            // platform generated (which the product does not know until it is also configured).
            secretSource: operatorSecret === null ? 'generated' : 'instance',
          },
        },
        tx,
      );
    });
    return { clientId, adapter };
  }

  async materialiseRoute(
    instanceId: string,
    input: RouteInput,
    actorId: string,
  ): Promise<InstanceRoute> {
    const instance = await this.instanceOf(instanceId);
    const host = (
      input.host ?? `${instance.slug}.${this.config.SEAMNEX_INGRESS_DOMAIN}`
    ).toLowerCase();
    const pathPrefix = input.pathPrefix ?? null;
    const publishModel = input.publishModel ?? (pathPrefix === null ? 'subdomain' : 'subpath');
    /*
     * The route's auth mode is the edge's copy of the entry's guarantee class, and the catalog is
     * the authority: the deploy pipeline calls this with no input at all, and defaulting to
     * `native` made every route claim native sign-in. Two things then went wrong together — a
     * `fa_gate` product was listed as single sign-on, and database invariant 12 rejected the
     * identity sync that tried to record `unsupported` for it, which failed the whole cycle and
     * left every newly deployed product absent from the portal launcher.
     */
    const declared = await this.guaranteeClassOf(instance.entryKey);
    if (input.authMode !== undefined && input.authMode !== declared) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        detail: `authMode "${input.authMode}" contradicts guaranteeClass "${declared}" of catalog entry ${instance.entryKey}.`,
        remediation:
          'Omit authMode so the route follows the catalog entry, or correct the entry first.',
      });
    }
    const authMode = declared;

    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      await tx.query(
        `INSERT INTO instance_route (instance_id, host, path_prefix, publish_model, tls_mode, auth_mode, published)
         VALUES ($1, $2, $3, $4, 'acme', $5, $6)
         ON CONFLICT (instance_id) DO UPDATE
            SET host = EXCLUDED.host, path_prefix = EXCLUDED.path_prefix,
                publish_model = EXCLUDED.publish_model, auth_mode = EXCLUDED.auth_mode,
                published = EXCLUDED.published, updated_at = now()`,
        [instanceId, host, pathPrefix, publishModel, authMode, input.published ?? true],
      );
      await this.audit.append(
        {
          action: 'instance.route.materialised',
          actorType: 'user',
          actorId,
          targetType: 'instance',
          targetId: instanceId,
          outcome: 'success',
          detail: { host, pathPrefix, publishModel, authMode },
        },
        tx,
      );
    });

    await this.projectInstance(instanceId);
    const route = await this.route(instanceId);
    if (route === null)
      throw new AppError({ code: 'INTERNAL_ERROR', detail: 'The route row was not created.' });
    return route;
  }

  async runChecks(
    instanceId: string,
  ): Promise<{ checks: IntegrationCheck[]; ready: boolean; blocking: string[] }> {
    const instance = await this.instanceOf(instanceId);
    const port = Number(instance.payload.httpPort ?? 80);
    const checks: { check: IntegrationCheck['check']; ok: boolean; detail: string }[] = [];

    const probe = await probeProductHttp({
      runCli: (file, args, timeoutMs) => this.docker.runCli(file, args, timeoutMs),
      network: instanceNetwork(instance.slug),
      host: instance.slug,
      port,
      timeoutMs: 10_000,
    });
    checks.push({
      check: 'http',
      ok: probe.ok,
      detail: probe.ok
        ? `HTTP answered on :${port} (${describeProbe(probe)})`
        : `no HTTP answer on :${port}`,
    });

    const route = await this.route(instanceId);
    const native = (route?.authMode ?? 'native') === 'native';
    /**
     * The attachment is re-applied before it is checked, for two reasons: a check that can only
     * observe a transient Docker attachment fails for a reason the platform can repair in one call,
     * and the repair is the difference between a login that completes and one that dies after the
     * browser has already been redirected back.
     */
    const attachment = await this.ensureIdentityAttachment(instanceId);
    const sso = await this.ssoLogin(instanceId, native, attachment);
    checks.push({ check: 'sso_login', ok: sso.ok, detail: sso.detail });

    const dnsOk = route !== null;
    checks.push({
      check: 'dns',
      ok: dnsOk,
      detail: dnsOk ? `${route.host} (${route.publishModel})` : 'no route materialised',
    });

    const schedule = await this.pool.query(
      `SELECT 1 FROM backup_schedule WHERE instance_id = $1 AND cadence <> 'off'`,
      [instanceId],
    );
    const registered = (schedule.rowCount ?? 0) > 0;
    checks.push({
      check: 'backup_registered',
      ok: registered,
      detail: registered ? 'backup schedule registered' : 'no backup schedule registered',
    });

    const hooks = await this.pool.query(`SELECT 1 FROM trigger_endpoint WHERE instance_id = $1`, [
      instanceId,
    ]);
    const hookCount = hooks.rowCount ?? 0;
    checks.push({
      check: 'webhook_registered',
      ok: hookCount > 0,
      detail:
        hookCount > 0
          ? `${hookCount} trigger endpoint(s) registered`
          : 'the product declares no triggers',
    });

    const previousSso = await this.latestSsoVerdict(instanceId);
    for (const check of checks) {
      await this.pool.query(
        `INSERT INTO integration_check (instance_id, check_type, ok, detail) VALUES ($1, $2, $3, $4)`,
        [instanceId, check.check, check.ok, check.detail],
      );
    }
    const ssoCheck = checks.find((check) => check.check === 'sso_login');
    if (ssoCheck !== undefined)
      await this.auditSsoTransition(instanceId, previousSso, ssoCheck.ok, ssoCheck.detail);

    // FR-2.9: the verdict, not the state. `instance` belongs to M05, so M07 reports and the
    // executor decides — a module that writes another module's table is a boundary violation, and
    // `module-boundaries.test.ts` is right to reject it.
    //
    // `backup_registered` and `webhook_registered` never block a first deploy: a schedule is created
    // after the instance exists, and a product may legitimately declare no triggers. Blocking on
    // them would make the first deployment of every product impossible.
    //
    // `sso_login` blocks only the forward-auth guarantee classes. For a `native` product the identity
    // authority is the product itself: an IdP that is not wired up yet says nothing about whether the
    // instance works, and blocking on it made every deployment of a native product fail after the
    // containers were already running.
    const blocking = checks
      .filter(
        (check) =>
          !check.ok &&
          (check.check === 'http' ||
            check.check === 'dns' ||
            (check.check === 'sso_login' && !native)),
      )
      .map((check) => `${check.check}: ${check.detail}`);
    return { checks: await this.checks(instanceId), ready: blocking.length === 0, blocking };
  }

  /**
   * 4D.5 — the SSO check, against the thing it claims to check.
   *
   * Three states, and the detail always says which one applies:
   *   - no `idp_client` row: the product was never wired for OIDC. This is a failure of the check,
   *     not a pass, because "the realm answers" says nothing about this product's sign-in;
   *   - a client row: the probe drives a real authorization request (and a code exchange when a
   *     probe identity is configured) against the registered client id and redirect URI;
   *   - the realm itself is unreachable: reported as such, with the native-product caveat kept in
   *     the wording so a local-credential product is not described as broken.
   */
  private async ssoLogin(
    instanceId: string,
    native: boolean,
    attachment: IdentityAttachment,
  ): Promise<SsoProbeResult> {
    const result = await this.pool.query<{
      client_id: string;
      client_secret_ref: string | null;
      redirect_uris: string[];
    }>(
      `SELECT client_id, client_secret_ref, redirect_uris FROM idp_client WHERE instance_id = $1`,
      [instanceId],
    );
    const row = result.rows[0];

    if (row === undefined) {
      const realm = await this.keycloak.realmReachable().catch(() => false);
      /**
       * What this check can actually say, and nothing more.
       *
       * It used to add "…this product signs in with its own store", which the platform cannot know:
       * the catalog's `ESPOCRM_CONFIG_AUTHENTICATION_METHOD` can be `Oidc` — local sign-in disabled —
       * while the client registration never reached the IdP. That sentence told an operator the exact
       * opposite of the truth and made a missing registration look like a design decision.
       */
      return {
        ok: false,
        detail: realm
          ? `no identity client is recorded for this instance${native ? ' although the catalog declares single sign-on' : ''}; the login leg was not verified`
          : 'the identity provider is not reachable, so the login leg was not verified',
      };
    }

    const redirectUri = row.redirect_uris[0];
    if (row.client_secret_ref === null || redirectUri === undefined) {
      return {
        ok: false,
        detail: `client ${row.client_id} has no secret or redirect URI on record; re-register it`,
      };
    }

    let secret: string;
    try {
      secret = await this.secrets.open(row.client_secret_ref, `sso check ${instanceId}`);
    } catch (error) {
      /**
       * The platform cannot read its own copy of the client secret. That is a platform fault, not a
       * product one — the product still holds the same secret and its login can be working — but
       * the check cannot prove anything, so it reports unverified. The usual cause is a root key
       * that was regenerated after the secret was sealed, which is exactly what a dev stack that
       * recreates `temp/` does.
       */
      return {
        ok: false,
        detail: `the client secret recorded for ${row.client_id} could not be opened (${error instanceof Error ? error.message : String(error)}); the login leg was not exercised — re-seal the secret or re-register the client`,
      };
    }

    /**
     * Stage 0 — the leg that was missing.
     *
     * Stages 1 and 2 run from the control plane, which can always reach the IdP. The product
     * redeems the code from *its own* network, and that is where EspoCRM failed: `getent hosts
     * keycloak` answered nothing, the token request died with status 0, and every check the
     * platform ran stayed green. Asking the same question from a container on the instance network
     * is the difference between checking the realm and checking the login.
     */
    const instance = await this.instanceOf(instanceId);
    if (!attachment.ok) {
      return { ok: false, detail: `stage 0 (product network): ${attachment.detail}` };
    }
    const reach = await probeIdpFromNetwork({
      runCli: (file, args, timeoutMs) => this.docker.runCli(file, args, timeoutMs),
      network: instanceNetwork(instance.slug),
      host: this.config.SEAMNEX_IDP_ALIAS,
      port: this.config.SEAMNEX_IDP_INTERNAL_PORT,
      path: `/realms/${this.config.SEAMNEX_KEYCLOAK_REALM}/.well-known/openid-configuration`,
      timeoutMs: 30_000,
    });
    if (!reach.ok) {
      return { ok: false, detail: `stage 0 (product network): ${reach.detail}` };
    }

    const groupClaim = oidcGroupClaimFor(instance.entryKey);
    return this.ssoProbe.verify({
      clientId: row.client_id,
      redirectUri,
      clientSecret: secret,
      ...(groupClaim === null ? {} : { expectedClaims: [groupClaim] }),
    });
  }

  /**
   * 4D.1 — re-applies the IdP's attachment to one instance network.
   *
   * Docker attachments are transient state: they belong to the container, so recreating Keycloak —
   * a `compose up` after an image update, a host restart that re-creates services — silently drops
   * every `seamnex-inst-*` membership, and the product's next login fails at the last step. The write
   * used to happen once, inside `registerIdentity`, and its failure was a warning. Both callers
   * (`runChecks`, `registerIdentity`) and the scheduler's reconciliation now share this one call,
   * and the result is returned so the check can record it instead of discarding it.
   */
  async ensureIdentityAttachment(instanceId: string): Promise<IdentityAttachment> {
    if (this.config.SEAMNEX_IDP_CONTAINER.length === 0) {
      return {
        ok: false,
        network: '',
        detail:
          'no identity provider container is configured (SEAMNEX_IDP_CONTAINER), so the product cannot reach the token endpoint from its own network',
      };
    }
    const instance = await this.instanceOf(instanceId);
    const network = instanceNetwork(instance.slug);
    try {
      await this.docker.connectNetwork(network, this.config.SEAMNEX_IDP_CONTAINER, [
        this.config.SEAMNEX_IDP_ALIAS,
      ]);
      return {
        ok: true,
        network,
        detail: `the identity provider is attached to ${network} as ${this.config.SEAMNEX_IDP_ALIAS}`,
      };
    } catch (error) {
      return {
        ok: false,
        network,
        detail: `the identity provider could not join ${network}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Re-runs only the login leg and records it — the write the periodic pass needs.
   *
   * `runChecks` is the deploy verdict: five checks, an HTTP probe, a readiness answer. Calling it on
   * a timer would write 25 rows a minute and probe every product's front page for no reason. The
   * label on a card depends on one of those checks, so that one is refreshable on its own.
   */
  async verifyIdentity(instanceId: string): Promise<SsoProbeResult> {
    const route = await this.route(instanceId);
    const native = (route?.authMode ?? 'native') === 'native';
    const attachment = await this.ensureIdentityAttachment(instanceId);
    const sso = await this.ssoLogin(instanceId, native, attachment);
    const previous = await this.latestSsoVerdict(instanceId);
    await this.pool.query(
      `INSERT INTO integration_check (instance_id, check_type, ok, detail) VALUES ($1, 'sso_login', $2, $3)`,
      [instanceId, sso.ok, sso.detail],
    );
    await this.auditSsoTransition(instanceId, previous, sso.ok, sso.detail);
    return sso;
  }

  /**
   * The scheduler's repair pass.
   *
   * Two jobs, and they exist for the same reason: the label on a card is a claim about the next
   * launch, so the evidence behind it has to be both present and recent.
   *   - the IdP's membership of each instance network is re-applied, because Docker drops it when
   *     either container is recreated and the product then fails at the last step of the login;
   *   - the login leg is re-verified once the recorded evidence is older than half the freshness
   *     window, so a card cannot stay "single sign-on" on a three-day-old pass and cannot stay
   *     "unverified" forever because nothing ever re-checks it.
   */
  async reconcileIdentityNetworks(): Promise<{
    instances: number;
    failed: number;
    verified: number;
  }> {
    if (this.config.SEAMNEX_IDP_CONTAINER.length === 0)
      return { instances: 0, failed: 0, verified: 0 };
    const result = await this.pool.query<{ id: string; last_checked: Date | null }>(
      `SELECT i.id,
              (SELECT max(ic.checked_at) FROM integration_check ic
                WHERE ic.instance_id = i.id AND ic.check_type = 'sso_login') AS last_checked
         FROM instance i JOIN idp_client c ON c.instance_id = i.id
        WHERE i.deleted_at IS NULL AND i.state IN ('ready', 'degraded')`,
    );
    const refreshAfterMs = (this.config.SEAMNEX_SSO_EVIDENCE_TTL_MINUTES / 2) * 60_000;
    let failed = 0;
    let verified = 0;

    for (const row of result.rows) {
      const attachment = await this.ensureIdentityAttachment(row.id);
      if (!attachment.ok) {
        failed += 1;
        this.logger.warn(attachment.detail);
        // One row per breakage, not one per pass: the same sentence is not re-recorded for five
        // minutes, which keeps a permanently broken instance readable.
        await this.pool.query(
          `INSERT INTO integration_check (instance_id, check_type, ok, detail)
           SELECT $1, 'sso_login', false, $2
            WHERE NOT EXISTS (
                    SELECT 1 FROM integration_check ic
                     WHERE ic.instance_id = $1 AND ic.check_type = 'sso_login' AND ic.ok = false
                       AND ic.detail = $2 AND ic.checked_at > now() - interval '5 minutes')`,
          [row.id, attachment.detail],
        );
        continue;
      }

      const stale =
        row.last_checked === null || Date.now() - row.last_checked.getTime() > refreshAfterMs;
      if (!stale) continue;
      const verdict = await this.verifyIdentity(row.id).catch((error: unknown) => ({
        ok: false,
        detail: `the periodic sign-in check failed: ${error instanceof Error ? error.message : String(error)}`,
      }));
      if (verdict.ok) verified += 1;
    }
    return { instances: result.rowCount ?? 0, failed, verified };
  }

  /** The last recorded SSO verdict, or `undefined` when the check has never run. */
  private async latestSsoVerdict(instanceId: string): Promise<boolean | undefined> {
    const previous = await this.pool.query<{ ok: boolean }>(
      `SELECT ok FROM integration_check
        WHERE instance_id = $1 AND check_type = 'sso_login'
        ORDER BY checked_at DESC LIMIT 1`,
      [instanceId],
    );
    return previous.rows[0]?.ok;
  }

  /**
   * FR-4.3 — a transition is the event worth recording, not every pass.
   *
   * Recording each run would flood the chain with the same sentence, and an operator investigating
   * "when did this break" would have to diff rows. A change of verdict is answered in one line:
   * what it was, what it is now, and the check's own sentence.
   */
  private async auditSsoTransition(
    instanceId: string,
    previous: boolean | undefined,
    now: boolean,
    detail: string,
  ): Promise<void> {
    if (previous === undefined || previous === now) return;
    await this.audit
      .append({
        action: now ? 'sso.check.recovered' : 'sso.check.failed',
        actorType: 'system',
        actorId: 'm07-integration',
        targetType: 'instance',
        targetId: instanceId,
        outcome: now ? 'success' : 'failure',
        detail: { previous, now, detail },
      })
      // The check row is already written; a chain outage must not turn a failed login into a
      // failed checks run as well.
      .catch((error: unknown) => {
        this.logger.warn(
          `the SSO verdict change could not be audited: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  async setAllRoutesGated(tx: Queryable, gated: boolean): Promise<void> {
    // One statement, no WHERE: the gate is platform-wide by definition.
    await tx.query(`UPDATE instance_route SET gated = $1, updated_at = now()`, [gated]);
  }

  async projectAll(): Promise<number> {
    const result = await this.pool.query<{ instance_id: string }>(
      `SELECT instance_id FROM instance_route`,
    );
    for (const row of result.rows) await this.projectInstance(row.instance_id);
    return result.rowCount ?? 0;
  }

  private async projectInstance(instanceId: string): Promise<void> {
    const result = await this.pool.query<{
      host: string;
      path_prefix: string | null;
      publish_model: string;
      published: boolean;
      gated: boolean;
      auth_mode: string;
      slug: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT r.host, r.path_prefix, r.publish_model, r.published, r.gated, r.auth_mode, i.slug, i.payload
         FROM instance_route r JOIN instance i ON i.id = r.instance_id
        WHERE r.instance_id = $1`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) return;

    // The router lives on the edge network, the product on its own instance network. A published
    // route is only real if the edge is attached to that network, so the projection joins the two
    // before writing the file: the upstream URL (`http://<slug>:<port>`) resolves by the alias the
    // renderer attaches, and nothing publishes a host port to make it work.
    if (row.published && !row.gated) await this.attachEdge(instanceNetwork(row.slug));

    this.traefik.write({
      slug: row.slug,
      host: row.host,
      pathPrefix: row.path_prefix,
      upstream: `http://${row.slug}:${Number(row.payload.httpPort ?? 80)}`,
      published: row.published && !row.gated,
      // The edge calls the auth-gateway role, not the public API surface (see create-forward-auth-app).
      forwardAuthAddress: 'http://auth-gateway:8090/verify',
      /*
       * The launch bootstrap is a plain upstream, so it takes the service origin, not `/verify`.
       *
       * ADR-BE-22 makes it configuration rather than a constant: a deployment that enables the relay
       * points this at the relay role, and the relay answers exactly this hop. A deployment that
       * does not enable it keeps the gateway, unchanged.
       */
      bootstrapAddress: this.config.SEAMNEX_BOOTSTRAP_URL,
      authMode: authModeOf(row.auth_mode),
    });
  }

  /**
   * Joins the edge container to an instance network.
   *
   * `SEAMNEX_EDGE_CONTAINER` names the Traefik container (the compose stack's `seamnex-dev-traefik-1`). Empty
   * disables the step, which is the honest default: a deployment that has no edge should not pretend
   * a route is reachable.
   */
  private async attachEdge(network: string): Promise<void> {
    if (this.config.SEAMNEX_EDGE_CONTAINER.length === 0) return;
    try {
      await this.docker.connectNetwork(network, this.config.SEAMNEX_EDGE_CONTAINER);
    } catch (error) {
      this.logger.warn(
        `the edge could not join ${network}: ${error instanceof Error ? error.message : String(error)}; the route will not answer until it does`,
      );
    }
  }

  private async instanceOf(instanceId: string): Promise<{
    id: string;
    slug: string;
    entryKey: string;
    host: string;
    payload: Record<string, unknown>;
  }> {
    const result = await this.pool.query<{
      id: string;
      slug: string;
      entry_key: string;
      host: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT i.id, i.slug, i.entry_key, r.host, i.payload
         FROM instance i LEFT JOIN instance_route r ON r.instance_id = i.id
        WHERE i.id = $1 AND i.deleted_at IS NULL`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No instance ${instanceId}.`,
        remediation: 'Refresh the instance list.',
      });
    }
    return {
      id: row.id,
      slug: row.slug,
      entryKey: row.entry_key,
      host: row.host ?? `${row.slug}.${this.config.SEAMNEX_INGRESS_DOMAIN}`,
      payload: row.payload,
    };
  }

  /**
   * The review-approved guarantee class of the entry, which the route mirrors. A missing entry is
   * a projection defect, not a reason to invent a sign-in shape: `native` is the schema default and
   * the readiness checks decide whether the deployment is usable.
   */
  private async guaranteeClassOf(
    entryKey: string,
  ): Promise<'native' | 'fa_header' | 'fa_delegated' | 'fa_gate'> {
    const result = await this.pool.query<{ guarantee_class: string | null }>(
      `SELECT guarantee_class FROM catalog_entry WHERE key = $1`,
      [entryKey],
    );
    return authModeOf(result.rows[0]?.guarantee_class ?? 'native');
  }
}

/** The route row stores the guarantee class; the edge only needs to know whether to gate at all. */
function authModeOf(value: string): 'native' | 'fa_header' | 'fa_delegated' | 'fa_gate' {
  if (value === 'fa_header' || value === 'fa_delegated' || value === 'fa_gate') return value;
  return 'native';
}

function randomSecret(): string {
  // 32 bytes of entropy, hex-encoded; the value is stored in M15 and never logged.
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
}
