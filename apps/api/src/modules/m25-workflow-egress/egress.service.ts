import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { DockerEngineClient } from '../../common/docker/docker.client';
import { AppError } from '../../common/problem/app-error';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { SECRETS_SERVICE, type SecretsService } from '../m15-secrets/secrets.contract';
import {
  CREDENTIAL_BROKER_SERVICE,
  type CredentialBrokerService,
} from '../m14-credential-broker/credential-broker.contract';
import { orangeHrmLogin } from '../m24-sign-in-relay/adapters/orangehrm-login';
import { productFetch } from '../m24-sign-in-relay/product-http';
import {
  ensureInstanceJoined,
  internalOriginFor,
  publicOriginFor,
} from '../m24-sign-in-relay/relay-origin';
import type {
  EgressRequest,
  EgressResponse,
  FieldDiscoveryRequest,
  FieldDiscoveryResult,
  WorkflowEgressService,
} from './egress.contract';
import { adapterFor } from './field-adapters';

/** The product's own description of one operation, as the registry projects it. */
type OperationSpec = {
  readonly id?: unknown;
  readonly mode?: unknown;
  readonly path?: unknown;
  readonly method?: unknown;
};

type Target = {
  readonly instanceId: string;
  readonly entryKey: string;
  readonly slug: string;
  readonly origin: string;
  readonly publicHost: string;
  readonly operations: readonly OperationSpec[];
};

/**
 * How the platform authenticates to one product on a workflow's behalf.
 *
 * This is product knowledge (which header the product honours, which variable holds the login), and
 * it lives here for the same reason the OIDC tables live in M07: the catalog declares the *policy*
 * ("can this product be written to?"), never a wire format. A product with no entry here is refused
 * rather than called anonymously — an unauthenticated POST would be a silent, misleading `401` in the
 * run panel instead of an operator-facing statement.
 */
const EGRESS_AUTH: Readonly<Record<string, EgressAuth>> = {
  // EspoCRM answers `200` to `Authorization: Basic` for its administrator (measured on the running
  // instance); it has no API-key equivalent on a fresh install.
  'D01-01': { kind: 'basic', username: 'admin', passwordSecret: 'ESPOCRM_ADMIN_PASSWORD' },
  // OrangeHRM's API takes the same session cookie the UI does. There is no token to hold, so the
  // broker signs in as the administrator the installer already created.
  'D07-01': {
    kind: 'session',
    usernameVariable: 'ORANGEHRM_ADMIN_USERNAME',
    passwordSecret: 'ORANGEHRM_ADMIN_PASSWORD',
  },
  'D09-01': { kind: 'bearer', tokenSecret: 'product_api_token' },
};

type EgressAuth =
  | { readonly kind: 'basic'; readonly username: string; readonly passwordSecret: string }
  | {
      readonly kind: 'session';
      readonly usernameVariable: string;
      readonly passwordSecret: string;
    }
  | { readonly kind: 'bearer'; readonly tokenSecret: string };

/** How long an administrator session is reused before the broker signs in again. */
const SESSION_TTL_MS = 10 * 60 * 1_000;

/** Headers that belong to one hop and must not be relayed. */
const HOP_HEADERS = new Set(['connection', 'transfer-encoding', 'content-length', 'set-cookie']);

@Injectable()
export class BrokerEgressService implements WorkflowEgressService {
  private readonly logger = new Logger('m25-workflow-egress');
  /** Instance networks this process joined, and when Docker last confirmed it; the TTL is shared. */
  private readonly joined = new Map<string, number>();
  /** Keyed by internal origin: one product's administrator session never answers for another. */
  private readonly sessions = new Map<string, { cookie: string; expiresAt: number }>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(SECRETS_SERVICE) private readonly secrets: SecretsService,
    @Inject(CREDENTIAL_BROKER_SERVICE) private readonly broker: CredentialBrokerService,
    @Inject(DockerEngineClient) private readonly docker: DockerEngineClient,
  ) {}

  async forward(input: EgressRequest): Promise<EgressResponse> {
    const started = Date.now();
    const refuse = async (
      status: number,
      code: string,
      detail: string,
      remediation?: string,
    ): Promise<EgressResponse> => {
      await this.record(input, status, code, Date.now() - started);
      return problem(status, code, detail, remediation);
    };

    if (input.token === null || input.token.length === 0) {
      return refuse(
        401,
        'UNAUTHORIZED',
        'The broker call carried no token.',
        'Re-activate the workflow: activation creates the n8n credential the nodes send.',
      );
    }
    const scope = await this.broker.verifyToken(input.token);
    if (scope === null) {
      return refuse(
        401,
        'UNAUTHORIZED',
        'The broker token is unknown, expired, revoked, or belongs to a version the workflow has moved past.',
        'Re-activate the workflow to issue a token for the current version.',
      );
    }
    if (!scope.operations.includes(input.operation)) {
      return refuse(
        403,
        'FORBIDDEN',
        `The token does not cover operation "${input.operation}" on this product.`,
        'Re-activate the workflow: the scope is minted from the operations its nodes declare.',
      );
    }

    const target = await this.target(scope.instanceId);
    if (target === null) {
      return refuse(
        404,
        'NOT_FOUND',
        'The product this token was minted for is gone.',
        'Rebuild the registry and re-activate the workflow.',
      );
    }
    if (target.entryKey !== input.entryKey) {
      return refuse(
        403,
        'FORBIDDEN',
        `The token authorises ${target.entryKey}, not "${input.entryKey}".`,
      );
    }

    const operation = target.operations.find((entry) => entry.id === input.operation);
    const path = typeof operation?.path === 'string' ? operation.path : null;
    const method = typeof operation?.method === 'string' ? operation.method : null;
    if (operation === undefined || path === null || method === null) {
      return refuse(
        409,
        'OPERATION_NOT_CALLABLE',
        `${target.entryKey} "${input.operation}" declares no path and method.`,
        'Record the endpoint in the catalog entry (integration.operationInventory), then rebuild the registry.',
      );
    }
    if (method !== input.method.toUpperCase()) {
      return refuse(
        405,
        'METHOD_NOT_ALLOWED',
        `${input.operation} is called with ${method}, not ${input.method.toUpperCase()}.`,
        'Re-activate the workflow so the compiled verb matches the catalog.',
      );
    }
    // C-11 restated at the wire: a read scope can never carry a write, whatever the compile did.
    if (operation.mode === 'write' && scope.mode !== 'write') {
      return refuse(
        403,
        'FORBIDDEN',
        `${target.entryKey} "${input.operation}" writes, and this token is read-only.`,
        'Re-activate the workflow: a write operation mints a write scope only for a scoped product.',
      );
    }

    await ensureInstanceJoined(this.docker, this.config, this.logger, this.joined, target.slug);

    let auth: Record<string, string>;
    try {
      auth = await this.authHeaders(target);
    } catch (error) {
      const detail = error instanceof AppError ? error.detail : messageOf(error);
      return refuse(
        502,
        'PRODUCT_CREDENTIAL_UNAVAILABLE',
        detail,
        error instanceof AppError ? error.remediation : undefined,
      );
    }

    let response: Response;
    try {
      response = await productFetch(`${target.origin}${path}${input.query}`, {
        method,
        redirect: 'manual',
        headers: {
          host: target.publicHost,
          accept: input.accept ?? 'application/json',
          ...(input.contentType === null ? {} : { 'content-type': input.contentType }),
          ...auth,
        },
        ...(input.body === null ? {} : { body: input.body }),
        signal: AbortSignal.timeout(this.config.SEAMNEX_EGRESS_TIMEOUT_MS),
      });
    } catch (error) {
      return refuse(
        502,
        'PRODUCT_UNREACHABLE',
        `${target.entryKey} could not be called: ${messageOf(error)}`,
        'Check that the product is running and that the instance network is attached.',
      );
    }

    const body = Buffer.from(await response.arrayBuffer());
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (!HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
    });

    await this.record(
      input,
      response.status,
      response.ok ? null : 'PRODUCT_REJECTED',
      Date.now() - started,
    );
    return { status: response.status, headers, body: body.length === 0 ? null : body };
  }

  /**
   * FR-5.5 — the fields one operation accepts, read from the product itself.
   *
   * This is the only place a product credential is combined with authoring: the caller is an
   * authenticated author in `m13`, the credential never leaves this process, and the answer is a list
   * of names and types — no raw payload, no headers, no product URL.
   *
   * A product that cannot describe its schema (`unsupported`) and a product that does not answer
   * (`unavailable`) are both ordinary answers. Turning them into errors would block authoring for a
   * reason the author cannot fix, so the caller caches the verdict and the console falls back to
   * manual entry.
   */
  async discoverFields(input: FieldDiscoveryRequest): Promise<FieldDiscoveryResult> {
    const target = await this.target(input.instanceId);
    if (target === null) {
      return {
        status: 'unavailable',
        detail: 'The product is not deployed, so its field list cannot be read.',
      };
    }
    if (target.entryKey !== input.entryKey) {
      return {
        status: 'unavailable',
        detail: 'The deployed product no longer matches the catalog entry this node names.',
      };
    }
    const adapter = adapterFor(target.entryKey);
    if (adapter === null) {
      return {
        status: 'unsupported',
        detail: `${target.entryKey} has no field-schema adapter, so field names are not validated.`,
      };
    }
    if (!adapter.supports(input.operation)) {
      return { status: 'unsupported', detail: adapter.unsupportedDetail };
    }

    await ensureInstanceJoined(this.docker, this.config, this.logger, this.joined, target.slug);

    let auth: Record<string, string>;
    try {
      auth = await this.authHeaders(target);
    } catch (error) {
      return {
        status: 'unavailable',
        detail: `The platform could not authenticate to ${target.entryKey}: ${messageOf(error)}`,
      };
    }

    let response: Response;
    try {
      response = await productFetch(`${target.origin}${adapter.path}`, {
        method: adapter.method,
        redirect: 'manual',
        headers: {
          host: target.publicHost,
          accept: 'application/json',
          ...(adapter.method === 'POST' ? { 'content-type': 'application/json' } : {}),
          ...auth,
        },
        ...(adapter.method === 'POST' ? { body: '{}' } : {}),
        signal: AbortSignal.timeout(this.config.SEAMNEX_EGRESS_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        status: 'unavailable',
        detail: `${target.entryKey} could not be reached to read its fields: ${messageOf(error)}`,
      };
    }
    if (!response.ok) {
      // The status only: a product body can echo a credential-free but still internal error.
      return {
        status: 'unavailable',
        detail: `${target.entryKey} answered ${response.status} when asked for its field schema.`,
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        status: 'unavailable',
        detail: `${target.entryKey} answered with a body that is not JSON.`,
      };
    }
    try {
      const fields = adapter.extract(payload, input.operation);
      if (fields.length === 0) {
        return { status: 'unsupported', detail: adapter.unsupportedDetail };
      }
      return { status: 'available', fields };
    } catch (error) {
      return {
        status: 'unavailable',
        detail: `The field schema of ${target.entryKey} could not be read: ${messageOf(error)}`,
      };
    }
  }

  /**
   * The product behind a token's instance, by the address the broker can actually dial.
   *
   * `internalOriginFor` is the instance-network alias (`http://orangehrm:80`); the published route is
   * only used for `Host`, because the product builds its responses from the name a browser uses.
   */
  private async target(instanceId: string): Promise<Target | null> {
    const result = await this.pool.query<{
      instance_id: string;
      entry_key: string;
      slug: string;
      payload: Record<string, unknown>;
      host: string | null;
      operations: unknown;
    }>(
      `SELECT i.id AS instance_id, i.entry_key, i.slug, i.payload, r.host,
              s.payload->'operations' AS operations
         FROM instance i
         LEFT JOIN instance_route r ON r.instance_id = i.id AND r.published AND NOT r.gated
         LEFT JOIN registry_snapshot s ON s.instance_id = i.id
        WHERE i.id = $1 AND i.deleted_at IS NULL
        LIMIT 1`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const origin = internalOriginFor(row.slug, row.payload);
    if (origin === null) return null;
    return {
      instanceId: row.instance_id,
      entryKey: row.entry_key,
      slug: row.slug,
      origin,
      publicHost:
        row.host === null ? row.slug : new URL(publicOriginFor(this.config, row.host)).host,
      operations: Array.isArray(row.operations) ? (row.operations as OperationSpec[]) : [],
    };
  }

  /** The credential headers for one product, fetched at call time and never cached beyond a session. */
  private async authHeaders(target: Target): Promise<Record<string, string>> {
    const strategy = EGRESS_AUTH[target.entryKey];
    if (strategy === undefined) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 502,
        detail: `${target.entryKey} declares no egress credential, so the broker will not call it.`,
        remediation:
          'Add the product to EGRESS_AUTH, or record that it exposes no machine credential.',
      });
    }
    switch (strategy.kind) {
      case 'bearer': {
        const token = await this.instanceSecret(target.instanceId, strategy.tokenSecret);
        return { authorization: `Bearer ${token}` };
      }
      case 'basic': {
        const password = await this.instanceSecret(target.instanceId, strategy.passwordSecret);
        return {
          authorization: `Basic ${Buffer.from(`${strategy.username}:${password}`, 'utf8').toString('base64')}`,
        };
      }
      case 'session': {
        const username = await this.instanceVariable(target.instanceId, strategy.usernameVariable);
        const password = await this.instanceSecret(target.instanceId, strategy.passwordSecret);
        const cookie = await this.orangeHrmSession(
          target.origin,
          publicOriginFor(this.config, target.publicHost),
          username,
          password,
        );
        return { cookie };
      }
    }
  }

  /**
   * The administrator session OrangeHRM's API accepts, cached for `SESSION_TTL_MS`.
   *
   * The same login driver the sign-in relay uses drives it, so a changed form, a forced password
   * change or a refused credential is reported the same way it is to a person.
   */
  private async orangeHrmSession(
    origin: string,
    publicOrigin: string,
    username: string,
    password: string,
  ): Promise<string> {
    const cached = this.sessions.get(origin);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.cookie;

    const result = await orangeHrmLogin.signIn(
      { origin, publicOrigin, username, credential: password },
      { timeoutMs: this.config.SEAMNEX_RELAY_HTTP_TIMEOUT_MS },
    );
    if (!result.ok) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 502,
        detail: `OrangeHRM refused the platform's administrator sign-in (${result.reason}): ${result.detail}`,
        remediation: 'Check ORANGEHRM_ADMIN_USERNAME / ORANGEHRM_ADMIN_PASSWORD for this instance.',
      });
    }
    // The driver emits the product's full `Set-Cookie` values; a request carries `name=value` only.
    const cookie = result.cookies
      .map((value) => value.split(';')[0] ?? '')
      .filter((pair) => pair.length > 0)
      .join('; ');
    this.sessions.set(origin, { cookie, expiresAt: Date.now() + SESSION_TTL_MS });
    return cookie;
  }

  private async instanceSecret(instanceId: string, name: string): Promise<string> {
    const found = await this.secrets.find('instance', instanceId, name);
    if (found === null) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 502,
        detail: `The instance has no ${name} secret, so the broker cannot authenticate.`,
        remediation: `Set ${name} on the instance, then re-run.`,
      });
    }
    return this.secrets.open(found.id, `workflow egress to ${instanceId}`, {
      scope: 'instance',
      ownerId: instanceId,
    });
  }

  private async instanceVariable(instanceId: string, name: string): Promise<string> {
    /*
     * `instance_env_value` holds `var_name` and `value_enc`, and a `secret`-sourced row keeps no
     * value there at all — that is what `secret_ref` is for. The previous query selected `name` and
     * `value`, columns this table has never had, so every product whose egress signs in with a
     * variable (`OrangeHRM`) failed at the driver with `42703` and surfaced as a 502 to the run panel.
     */
    const result = await this.pool.query<{ value_enc: Buffer | null }>(
      `SELECT value_enc FROM instance_env_value
        WHERE instance_id = $1 AND var_name = $2 AND source <> 'secret'
        LIMIT 1`,
      [instanceId, name],
    );
    const value = result.rows[0]?.value_enc?.toString('utf8');
    if (value === undefined || value.length === 0) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 502,
        detail: `The instance has no ${name} variable, so the broker cannot authenticate.`,
        remediation: `Set ${name} on the instance, then re-run.`,
      });
    }
    return value;
  }

  /**
   * One audit row per brokered call.
   *
   * The detail names the product, the operation and the outcome — never the token, the credential or
   * the payload. A refused call is audited too: "the run failed" without this row cannot say whether
   * the platform refused it or the product did.
   */
  private async record(
    input: EgressRequest,
    status: number,
    code: string | null,
    durationMs: number,
  ): Promise<void> {
    try {
      await this.audit.append({
        action: 'workflow.egress',
        actorType: 'service',
        actorId: 'broker-proxy',
        targetType: 'instance',
        targetId: input.entryKey,
        outcome: code === null && status < 400 ? 'success' : 'failure',
        detail: {
          operation: input.operation,
          method: input.method.toUpperCase(),
          status,
          ...(code === null ? {} : { code }),
          durationMs,
        },
      });
    } catch (error) {
      // The call already happened; failing it now would report the audit as the product's answer.
      this.logger.warn(`workflow.egress could not be audited: ${messageOf(error)}`);
    }
  }
}

function problem(
  status: number,
  code: string,
  detail: string,
  remediation?: string,
): EgressResponse {
  const body = Buffer.from(
    JSON.stringify({ code, detail, ...(remediation === undefined ? {} : { remediation }) }),
    'utf8',
  );
  return {
    status,
    headers: { 'content-type': 'application/problem+json' },
    body,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
