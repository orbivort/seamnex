import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  AuthMode,
  EntitlementResponse,
  LaunchEvent,
  LaunchTarget,
  LaunchTicket,
  LauncherResponse,
  LauncherTile,
  Me,
  RequestableProduct,
  SsoState,
  StatusBanner,
} from '@seamnex/domain';
import {
  authLabelFor,
  canonicalVersion,
  forwardsIdentity,
  guaranteeShort,
  requiresEdgeSession,
  signInPathFor,
  updateAvailable,
  type SignInShape,
  type SsoHealth,
} from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { AppError } from '../../common/problem/app-error';
import { initialsOf } from '../../common/identity/initials';
import { isUuid } from '../../common/http/uuid';
import { launchBootstrapUrl, launchTicketKey } from '../../common/launch/bootstrap';
import { REDIS } from '../../redis/redis.module';
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  ACCESS_CONTROL_SERVICE,
  type AccessControlService,
} from '../m09-access-control/access-control.contract';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { SIGN_IN_RELAY, type SignInRelay } from '../m24-sign-in-relay/relay.contract';
import { Repository, type Queryable } from '@seamnex/db';
import type { MeSession, PortalBffService } from './portal-bff.contract';

type TileRow = {
  instance_id: string;
  entry_key: string;
  slug: string;
  product_role: string;
  source: 'group' | 'direct';
  sync_state: string;
  synced_at: Date;
  state: string;
  ready: boolean | null;
  reason: string | null;
  observed_at: Date | null;
  payload: Record<string, unknown> | null;
  entry_payload: Record<string, unknown> | null;
  guarantee_class: string | null;
  host: string | null;
  path_prefix: string | null;
  published: boolean | null;
  auth_mode: string | null;
  maintenance_title: string | null;
  /** Non-null when the instance has an identity client at the platform's IdP. */
  idp_client_id: string | null;
  /** The latest end-to-end `sso_login` check: what the platform has actually proven. */
  sso_ok: boolean | null;
  sso_detail: string | null;
  sso_checked_at: Date | null;
  /** The primary service's image tag: what this deployment runs, not what the catalog pins. */
  deployed_version: string | null;
  /** The catalog entry's pinned and upstream versions, for "is this deployment current?". */
  entry_version: string | null;
  latest_version: string | null;
};

/**
 * Deliverable 2.6 — the portal BFF.
 *
 * One query, one join tree, no per-tile lookup: `GET /me/launcher` is the hottest read in the
 * platform (NFR-2.1, exit criterion 3) and must not fan out per instance. Maintenance is layered
 * last so an active window always wins over the health state.
 */

@Injectable()
export class PostgresPortalBffService extends Repository implements PortalBffService {
  private readonly logger = new Logger('m10-portal-bff');

  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ACCESS_CONTROL_SERVICE) private readonly access: AccessControlService,
    @Inject(REDIS) private readonly redis: Redis,
    /** A launch is evidence (FR-4.3): the click is the only moment the platform can record it. */
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    /**
     * ADR-BE-22 — the card's view of the relay. Optional because this service must stay mountable
     * without M24's relay half: the dialog then says the same thing it said before, rather than
     * failing the launch target a person asked for.
     */
    @Optional()
    @Inject(SIGN_IN_RELAY)
    private readonly relay?: SignInRelay,
  ) {
    super(pool);
  }

  /**
   * One statement, the same one governance used to run. `instance` is read here (declared in this
   * module's `reads`) and `entitlement` — which this module owns — is written.
   */
  async grantDirectEntitlement(
    tx: Queryable,
    input: { readonly subjectIdpId: string; readonly target: string },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO entitlement (subject_idp_id, instance_id, product_role, source, sync_state)
       SELECT $1, i.id, 'member', 'direct', 'applied' FROM instance i
        WHERE i.id::text = $2 OR i.slug = $2 OR i.entry_key = $2
       ON CONFLICT (subject_idp_id, instance_id, product_role) DO NOTHING`,
      [input.subjectIdpId, input.target],
    );
  }

  /**
   * The owner grant a deployment implies, written once per instance.
   *
   * `ON CONFLICT ... DO NOTHING` covers the retried request and the redeploy of a slug that was
   * deleted and installed again; the role is a label the portal prints ("Your access"), so it says
   * what the person is rather than repeating the platform role they already hold.
   */
  async grantInstanceOwner(instanceId: string, subjectIdpId: string): Promise<boolean> {
    const granted = await this.execute(
      `INSERT INTO entitlement (subject_idp_id, instance_id, product_role, source, sync_state)
       SELECT $2, i.id, 'Owner', 'direct', 'applied'
         FROM instance i
        WHERE i.id::text = $1 AND i.deleted_at IS NULL
       ON CONFLICT (subject_idp_id, instance_id, product_role) DO NOTHING`,
      [instanceId, subjectIdpId],
    );
    // A repeat grant is already the desired state, so a zero row count is only a failure when the
    // instance is genuinely absent; the idempotent no-op must not read as one.
    if (granted > 0) return true;
    const live = await this.one<{ id: string }>(
      `SELECT id FROM instance WHERE id::text = $1 AND deleted_at IS NULL`,
      [instanceId],
    );
    return live !== undefined;
  }

  async me(subjectIdpId: string, session: MeSession): Promise<Me> {
    const [row, grants] = await Promise.all([
      this.one<{
        idp_id: string;
        username: string;
        display_name: string | null;
        email: string | null;
        updated_at: Date;
      }>(
        `SELECT idp_id, username, display_name, email, updated_at FROM idp_user WHERE idp_id = $1`,
        [subjectIdpId],
      ),
      this.access.grantsFor(subjectIdpId),
    ]);
    // The session carries the role the provider asserted; a seeded binding, when present, is the
    // durable authority. Neither is invented here.
    const primaryRole = grants[0]?.role ?? session.roles[0] ?? 'R5';
    const projectedGrants =
      grants.length > 0
        ? grants.map((grant) => ({
            role: grant.role,
            scopeType: grant.scopeType,
            scopeId: grant.scopeId,
            scopeLabel:
              grant.scopeId ?? (grant.scopeType === 'platform' ? 'Platform' : grant.scopeType),
            source: 'role_binding',
            expiresAt: grant.expiresAt,
          }))
        : session.roles.map((role) => ({
            role,
            scopeType: 'platform' as const,
            scopeId: null,
            scopeLabel: 'Platform',
            source: 'session',
            expiresAt: null,
          }));

    return {
      id: subjectIdpId,
      username: row?.username ?? subjectIdpId,
      // The mirror's display name is the person's name; the login name is the fallback, not the
      // other way round (the header rendered "dev-admin" for a directory that says "Platform
      // Administrator").
      displayName: row?.display_name ?? row?.username ?? subjectIdpId,
      email: row?.email ?? `${subjectIdpId}@seamnex.local`,
      initials: initialsOf(row?.display_name ?? row?.username ?? subjectIdpId),
      primaryRole,
      roles: projectedGrants,
      // The session is the authority for MFA and expiry (deliverable 3.3): the profile reports
      // what the provider asserted, never an inference from the role.
      mfaSatisfied: session.mfaSatisfied,
      mfaMethod: session.mfaMethod,
      sessionExpiresAt: session.sessionExpiresAt,
      identitySyncedAt: (row?.updated_at ?? new Date()).toISOString(),
      groups: [...session.groups],
    };
  }

  async entitlements(subjectIdpId: string): Promise<EntitlementResponse> {
    const rows = await this.tiles(subjectIdpId);
    const entitlements = rows.map((row) => {
      const domain = this.textOf(row, 'domain', 'Platform');
      const guaranteeClass = (row.guarantee_class ?? 'native') as LauncherTile['guaranteeClass'];
      return {
        instanceId: row.instance_id,
        entryKey: row.entry_key,
        domain,
        product: this.textOf(row, 'product', row.entry_key),
        slug: row.slug,
        productRole: row.product_role,
        source: row.source as 'group' | 'direct',
        groupPath: row.source === 'group' ? `/${domain.toLowerCase()}` : 'Direct grant',
        syncState: row.sync_state as EntitlementResponse['entitlements'][number]['syncState'],
        syncedAt: row.synced_at.toISOString(),
        launchable: row.ready === true && row.published !== false,
        // The same label the tile shows, from the same guarantee class and sign-in shape.
        authLabel: authLabelFor(guaranteeClass, this.ssoStateOf(row)),
      };
    });

    return {
      subject: { id: subjectIdpId, name: subjectIdpId },
      generatedAt: new Date().toISOString(),
      entitlements,
      summary: {
        total: entitlements.length,
        domains: new Set(entitlements.map((entry) => entry.domain)).size,
        pending: entitlements.filter((entry) => entry.syncState === 'pending').length,
        signInRequired: entitlements.filter(
          (entry) => entry.authLabel === guaranteeShort('fa_gate'),
        ).length,
      },
    };
  }

  async launcher(subjectIdpId: string): Promise<LauncherResponse> {
    const rows = await this.tiles(subjectIdpId);
    const tiles = rows.map((row) => this.tile(row));
    return {
      environment: process.env.SEAMNEX_ENVIRONMENT_NAME ?? 'seamnex-local',
      generatedAt: new Date().toISOString(),
      tiles,
      counts: {
        total: tiles.length,
        available: tiles.filter((tile) => tile.plainStatus === 'available').length,
        degraded: tiles.filter((tile) => tile.plainStatus === 'degraded').length,
        unavailable: tiles.filter((tile) => tile.plainStatus === 'unavailable').length,
        maintenance: tiles.filter((tile) => tile.plainStatus === 'maintenance').length,
      },
    };
  }

  async launchTarget(subjectIdpId: string, instanceId: string): Promise<LaunchTarget> {
    if (!isUuid(instanceId)) throw notFound(instanceId);
    const rows = await this.tiles(subjectIdpId);
    const row = rows.find((candidate) => candidate.instance_id === instanceId);
    if (row === undefined) {
      throw new AppError({
        code: 'FORBIDDEN',
        detail: 'The subject holds no entitlement for this instance.',
        remediation: 'Request access to the product.',
      });
    }
    // Three sign-in shapes, and the label must match the one in force:
    //   - a forward-auth route: the edge injects the identity, nothing is asked of the user;
    //   - a registered identity client on a `native` product: it redirects to the platform IdP
    //     itself — one redirect, no second credential;
    //   - anything else, including a proxy gate with a leftover client row: the product has its own
    //     account, and saying "single sign-on" would be a lie.
    //
    // A registered client is not a working login, which is why the shape alone no longer decides
    // the label: `ssoState` is `sso` only while a recent end-to-end check passes. The note is
    // per-entry, because the path a product takes differs (EspoCRM renders its own card and opens
    // the IdP in a popup) and the general sentence was wrong for it.
    const shape = this.shapeOf(row);
    const ssoState = this.ssoStateOf(row);
    // Any gated route — the proxy gate included — reads the session from a cookie on the product's
    // own host, which the portal cannot set; the plain URL would land on a 401.
    const bootstrapRequired = requiresEdgeSession(row.auth_mode as AuthMode | null);
    const relayState = await this.relayStateOf(bootstrapRequired, row.instance_id, subjectIdpId);
    return {
      instanceId: row.instance_id,
      url: this.urlOf(row),
      authClass: (row.guarantee_class ?? 'native') as LaunchTarget['authClass'],
      ssoState,
      note: signInPathFor(row.entry_key, shape).note,
      opensInNewTab: true,
      bootstrapRequired,
      ssoHealth: this.ssoHealthOf(row),
      relayState,
    };
  }

  /**
   * Whether the relay has something to sign this person in as.
   *
   * Asked only for a gated route: `accountState` would answer `unavailable` for the rest anyway, and
   * the launcher is the hottest read in the platform (NFR-2.1) — a per-tile round trip on every
   * dialog would be paid for every product to describe the ones that do not relay.
   */
  private async relayStateOf(
    bootstrapRequired: boolean,
    instanceId: string,
    subjectIdpId: string,
  ): Promise<LaunchTarget['relayState']> {
    if (!bootstrapRequired || this.relay === undefined) return 'unavailable';
    /*
     * A read about sign-in must not be able to block a launch. The dialog renders this as one line
     * among several, and `AsyncPanel` would replace the whole body — and the Open button — with a
     * problem if this threw. Both reads share this service's pool, so an outage fails them together
     * and there is nothing to save; a fault specific to M24 (a shape change, a bad key) is exactly
     * the case where the person should still be able to open the product.
     */
    return this.relay.accountState({ instanceId, subjectIdpId }).catch((error: unknown) => {
      this.logger.warn(
        `the relay state for ${instanceId} could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'unavailable' as const;
    });
  }

  /**
   * What the product's sign-in path is *shaped* like, independent of whether it currently works.
   *
   * A proxy gate (`fa_gate`) never hands the product an identity: the edge requires a platform
   * session and the product then asks for its own credential. `registerIdentity` still runs for
   * every instance, so a gated product can carry an `idp_client` row — and reading that row as
   * `native-oidc` is how OpenProject's dialog came to promise a redirect its Community edition
   * cannot make (the OmniAuth strategy needs an Enterprise token; ADR-BE-15).
   */
  private shapeOf(row: Pick<TileRow, 'auth_mode' | 'idp_client_id'>): SignInShape {
    const authMode = row.auth_mode as AuthMode | null;
    if (forwardsIdentity(authMode)) return 'forwarded';
    if (authMode === 'fa_gate') return 'local';
    return row.idp_client_id === null ? 'local' : 'native-oidc';
  }

  /** The evidence behind `ssoState`, so a card and its dialog can print what has actually run. */
  private ssoHealthOf(row: Pick<TileRow, 'sso_ok' | 'sso_detail' | 'sso_checked_at'>): SsoHealth {
    const checkedAt = row.sso_checked_at ?? null;
    const ok = row.sso_ok === true;
    return {
      // `null` and "the column was not selected" are the same answer here: nothing has been proven.
      checked: checkedAt !== null,
      ok,
      checkedAt: checkedAt?.toISOString() ?? null,
      detail: row.sso_detail ?? '',
      reason:
        checkedAt === null
          ? 'never_checked'
          : !ok
            ? 'failed'
            : this.withinEvidenceWindow(checkedAt)
              ? 'ok'
              : 'stale',
    };
  }

  private withinEvidenceWindow(checkedAt: Date): boolean {
    const ttlMinutes = this.config.SEAMNEX_SSO_EVIDENCE_TTL_MINUTES ?? 60;
    return Date.now() - checkedAt.getTime() <= ttlMinutes * 60_000;
  }

  /**
   * The sign-in shape the launch target uses, so the card and the dialog cannot disagree.
   *
   * `sso_unverified` is the state that was missing. The previous rule was "an identity client row
   * exists ⇒ single sign-on", which is a registration and not a login: EspoCRM answered `token
   * request error` for two days while every card claimed success. A `native` client now counts as
   * `sso` only while the latest end-to-end check passed inside the freshness window; otherwise the
   * card says the path is unverified, which is a true statement about what the platform knows.
   */
  private ssoStateOf(
    row: Pick<TileRow, 'auth_mode' | 'idp_client_id' | 'sso_ok' | 'sso_checked_at'>,
  ): SsoState {
    const authMode = row.auth_mode as AuthMode | null;
    if (forwardsIdentity(authMode)) return 'sso';
    // A gate has no platform-issued session to prove, whatever client row the registration left
    // behind. `sso_login` can pass for a gate (the client is registered and the route answers), so
    // evidence alone would let a proxy gate be reported as single sign-on again.
    if (authMode === 'fa_gate') return 'sign_in_required';
    if (row.idp_client_id === null) return 'sign_in_required';
    const checkedAt = row.sso_checked_at ?? null;
    const proven =
      row.sso_ok === true && checkedAt !== null && this.withinEvidenceWindow(checkedAt);
    return proven ? 'sso' : 'sso_unverified';
  }

  /**
   * Mints the single-use ticket the edge redeems. It is deliberately short-lived and tied to the
   * caller's own session: the ticket only carries a session id the browser already holds, so a
   * leaked URL cannot promote anyone — it can only re-plant an existing session on one route.
   */
  async launchTicket(
    subjectIdpId: string,
    instanceId: string,
    sessionId: string | null,
  ): Promise<LaunchTicket> {
    if (sessionId === null) {
      throw new AppError({
        code: 'UNAUTHORIZED',
        detail: 'A launch ticket is minted for a browser session only.',
        remediation: 'Sign in through the portal and open the product from the launcher.',
      });
    }
    const rows = await this.tiles(subjectIdpId);
    const row = rows.find((candidate) => candidate.instance_id === instanceId);
    if (row === undefined) {
      throw new AppError({
        code: 'FORBIDDEN',
        detail: 'The subject holds no entitlement for this instance.',
        remediation: 'Request access to the product.',
      });
    }
    if (!requiresEdgeSession(row.auth_mode as AuthMode | null)) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        detail: 'This product is not gated at the edge; its plain URL needs no ticket.',
        remediation: 'Open the product from the launcher instead of requesting a ticket.',
      });
    }

    const ticket = randomBytes(24).toString('base64url');
    const ttl = this.config.LAUNCH_TICKET_TTL_SECONDS;
    await this.redis.set(
      launchTicketKey(ticket),
      JSON.stringify({ sessionId, instanceId: row.instance_id }),
      'EX',
      ttl,
    );
    return {
      url: launchBootstrapUrl(this.urlOf(row), ticket),
      expiresAt: new Date(Date.now() + ttl * 1_000).toISOString(),
    };
  }

  /**
   * FR-4.3 — the launch trail.
   *
   * Written here rather than on the read path: `GET /portal/launch-targets` is polled by the dialog
   * and would record a launch every time a card was opened, while this endpoint is called once, by
   * the click that actually opens the product. The row carries the sign-in shape in force at that
   * moment, so "the user was promised a single redirect and got a login page" is answerable after
   * the fact.
   */
  async recordLaunch(subjectIdpId: string, instanceId: string): Promise<LaunchEvent> {
    if (!isUuid(instanceId)) throw notFound(instanceId);
    const rows = await this.tiles(subjectIdpId);
    const row = rows.find((candidate) => candidate.instance_id === instanceId);
    if (row === undefined) {
      throw new AppError({
        code: 'FORBIDDEN',
        detail: 'The subject holds no entitlement for this instance.',
        remediation: 'Request access to the product.',
      });
    }
    const ssoState = this.ssoStateOf(row);
    const recordedAt = new Date().toISOString();
    await this.audit.append({
      action: 'portal.launch.requested',
      actorType: 'user',
      actorId: subjectIdpId,
      targetType: 'instance',
      targetId: instanceId,
      outcome: 'success',
      detail: { entryKey: row.entry_key, slug: row.slug, ssoState, ssoOk: row.sso_ok === true },
    });
    return { instanceId, recordedAt, ssoState };
  }

  async product(subjectIdpId: string, slug: string): Promise<LauncherTile> {
    const rows = await this.tiles(subjectIdpId);
    const row = rows.find((candidate) => candidate.slug === slug);
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No product ${slug} is visible to this subject.`,
        remediation: 'Refresh the launcher; unentitled products are not listed.',
      });
    }
    return this.tile(row);
  }

  async requestable(subjectIdpId: string): Promise<RequestableProduct[]> {
    const rows = await this.many<{
      key: string;
      domain: string;
      product: string;
      guarantee_class: string;
      payload: Record<string, unknown>;
      requested_at: Date | null;
    }>(
      `SELECT c.key, c.domain, c.product, c.guarantee_class, c.payload,
              (SELECT a.created_at FROM access_request a
                WHERE a.requester_idp_id = $1 AND a.target = c.key AND a.state = 'open'
                ORDER BY a.created_at DESC LIMIT 1) AS requested_at
         FROM catalog_entry c
        WHERE NOT EXISTS (
                SELECT 1 FROM entitlement e JOIN instance i ON i.id = e.instance_id
                 WHERE e.subject_idp_id = $1 AND i.entry_key = c.key AND i.deleted_at IS NULL)
        ORDER BY c.product`,
      [subjectIdpId],
    );
    return rows.map((row) => ({
      entryKey: row.key,
      domain: row.domain,
      product: row.product,
      description: String(row.payload.description ?? `${row.product} in ${row.domain}.`),
      guaranteeClass: row.guarantee_class as RequestableProduct['guaranteeClass'],
      productRole: 'member',
      owner: String((row.payload.owner as { name?: string } | undefined)?.name ?? row.domain),
      requested: row.requested_at !== null,
      requestedAt: row.requested_at?.toISOString() ?? null,
    }));
  }

  async statusBanner(): Promise<StatusBanner | null> {
    const row = await this.one<{
      id: string;
      scope: string;
      starts_at: Date;
      ends_at: Date;
      created_at: Date;
    }>(
      `SELECT id, scope, starts_at, ends_at, created_at FROM maintenance_window
        WHERE cancelled_at IS NULL AND now() BETWEEN starts_at AND ends_at
        ORDER BY starts_at DESC LIMIT 1`,
    );
    if (row === undefined) return null;
    return {
      id: row.id,
      severity: 'warning',
      title: 'Maintenance in progress',
      message: `A maintenance window ends at ${row.ends_at.toISOString()}.`,
      active: true,
      updatedAt: row.created_at.toISOString(),
      windowId: row.id,
    };
  }

  private tile(row: TileRow): LauncherTile {
    const ready = row.ready === true;
    const maintenance = row.maintenance_title !== null;
    const plainStatus: LauncherTile['plainStatus'] = maintenance
      ? 'maintenance'
      : ready
        ? 'available'
        : row.state === 'degraded'
          ? 'degraded'
          : 'unavailable';
    const guaranteeClass = (row.guarantee_class ?? 'native') as LauncherTile['guaranteeClass'];
    const ssoState = this.ssoStateOf(row);
    // The running image tag wins over the catalog pin: a deployment left on the previous version
    // after a rolled-back upgrade must not be reported as the pinned one.
    //
    // The comparison is a version precedence, not string inequality: the tag carries a `v`
    // (`v16.53.0`) that the catalog does not (`16.53.0`), so `!==` announced an update for the
    // version the deployment was already running. See `updateAvailable` for the full rule.
    const version = canonicalVersion(row.deployed_version) ?? canonicalVersion(row.entry_version);
    const latestVersion = canonicalVersion(row.latest_version);
    return {
      instanceId: row.instance_id,
      entryKey: row.entry_key,
      // Names come from the catalog entry, which is the reviewed document. The instance payload is
      // a snapshot written at deploy time and drifts: three deployments of D1 carried two different
      // domain labels, so the same product listed under two clusters.
      domain: this.textOf(row, 'domain', 'Platform'),
      product: this.textOf(row, 'product', row.entry_key),
      description: this.textOf(row, 'description', row.entry_key),
      slug: row.slug,
      url: this.urlOf(row),
      version,
      availableVersion: updateAvailable(version, latestVersion) ? latestVersion : null,
      plainStatus,
      guaranteeClass,
      ssoState,
      ssoHealth: this.ssoHealthOf(row),
      authLabel: authLabelFor(guaranteeClass, ssoState),
      productRole: row.product_role,
      launchable: plainStatus === 'available' && row.published !== false,
      degradedReason: plainStatus === 'degraded' ? row.reason : null,
      maintenanceTitle: row.maintenance_title,
      lastVerifiedAt: new Date(row.observed_at ?? row.synced_at).toISOString(),
      badge: row.sync_state === 'pending' ? 'Sync pending' : null,
    };
  }

  /** A catalog-first field read: the entry document outranks the instance's deploy-time snapshot. */
  private textOf(
    row: TileRow,
    key: 'domain' | 'product' | 'description',
    fallback: string,
  ): string {
    const fromCatalog = row.entry_payload?.[key];
    const fromInstance = row.payload?.[key];
    const value =
      typeof fromCatalog === 'string' && fromCatalog.length > 0 ? fromCatalog : fromInstance;
    return typeof value === 'string' && value.length > 0 ? value : fallback;
  }

  /**
   * The URL a browser opens. The scheme and port belong to the edge, not to the product, so they
   * come from configuration: production terminates TLS on 443, the dev edge serves HTTP on 8020.
   * Hardcoding `https://<host>` produced a link to a port nothing listened on in a dev stack.
   */
  private urlOf(row: TileRow): string {
    const host = row.host ?? `${row.slug}.${this.config.SEAMNEX_INGRESS_DOMAIN}`;
    const port =
      this.config.SEAMNEX_PRODUCT_URL_PORT === '' ? '' : `:${this.config.SEAMNEX_PRODUCT_URL_PORT}`;
    return `${this.config.SEAMNEX_PRODUCT_URL_SCHEME}://${host}${port}${row.path_prefix ?? ''}`;
  }

  /**
   * One row per instance, never per entitlement.
   *
   * A subject can hold more than one product role on the same instance — a direct `admin` grant from
   * the seed and a group-derived `member` from an identity sync are both legitimate rows. Projecting
   * them as-is rendered the same tile twice (React keyed it by instance and collapsed one, so the
   * grid silently lost a count), and `/me/entitlements` listed the product twice with different
   * roles. A direct grant wins over a derived one, then the most recently synced, then the role name,
   * so the projection is deterministic rather than "whichever row the planner returned first".
   */
  private async tiles(subjectIdpId: string): Promise<TileRow[]> {
    return this.many<TileRow>(
      `SELECT t.instance_id, t.entry_key, t.slug, t.product_role, t.source, t.sync_state, t.synced_at,
              t.state, t.ready, t.reason, t.observed_at, t.payload, t.entry_payload,
              t.guarantee_class, t.host, t.path_prefix, t.published, t.auth_mode, t.maintenance_title,
              t.idp_client_id, t.sso_ok, t.sso_detail, t.sso_checked_at,
              t.deployed_version, t.entry_version, t.latest_version
         FROM (
           SELECT DISTINCT ON (i.id)
                  e.instance_id, i.entry_key, i.slug, e.product_role, e.source, e.sync_state, e.synced_at,
                  i.state, s.ready, s.reason, s.observed_at, i.payload, c.payload AS entry_payload,
                  c.guarantee_class, r.host, r.path_prefix, r.published, r.auth_mode,
                  ic.client_id AS idp_client_id,
                  -- The latest end-to-end SSO check, not the latest row of any kind: the label is a
                  -- promise about the next launch, so it reads the evidence for that promise.
                  sso.ok AS sso_ok, sso.detail AS sso_detail, sso.checked_at AS sso_checked_at,
                  c.payload->'upstream'->>'currentVersion' AS entry_version,
                  c.payload->'upstream'->>'latestVersion' AS latest_version,
                  -- The tag of the primary service is the version the deployment runs. The catalog
                  -- pin says what it *should* run, and the two differ after a partial rollback.
                  (SELECT CASE WHEN svc.image_ref LIKE '%:%'
                               THEN substring(split_part(svc.image_ref, '@', 1) from '([^:]+)$')
                          END
                     FROM instance_service svc
                    WHERE svc.instance_id = i.id AND svc.role = 'primary'
                    ORDER BY svc.service_name
                    LIMIT 1) AS deployed_version,
                  (SELECT m.scope FROM maintenance_window m
                    WHERE m.instance_id = i.id AND m.cancelled_at IS NULL AND now() BETWEEN m.starts_at AND m.ends_at
                    ORDER BY m.starts_at DESC LIMIT 1) AS maintenance_title
             FROM entitlement e
             JOIN instance i ON i.id = e.instance_id AND i.deleted_at IS NULL
             LEFT JOIN instance_status s ON s.instance_id = i.id
             LEFT JOIN instance_route r ON r.instance_id = i.id
             LEFT JOIN catalog_entry c ON c.key = i.entry_key
             LEFT JOIN idp_client ic ON ic.instance_id = i.id
             LEFT JOIN LATERAL (
               SELECT ic2.ok, ic2.detail, ic2.checked_at
                 FROM integration_check ic2
                WHERE ic2.instance_id = i.id AND ic2.check_type = 'sso_login'
                ORDER BY ic2.checked_at DESC
                LIMIT 1
             ) sso ON true
            WHERE e.subject_idp_id = $1
            ORDER BY i.id, (e.source = 'direct') DESC, e.synced_at DESC, e.sync_state, e.product_role
         ) t
        -- Product first, then the deployment: three instances of one entry are otherwise ordered by
        -- whatever the planner returned, which reorders the grid between two refreshes.
        ORDER BY t.entry_key, t.slug`,
      [subjectIdpId],
    );
  }
}

function notFound(id: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No instance ${id}.`,
    remediation: 'Refresh the launcher.',
  });
}
