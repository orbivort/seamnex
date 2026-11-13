import { Inject, Injectable } from '@nestjs/common';
import { redactValue } from '../../common/logging/masking';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { productFetch } from './product-http';
import type {
  CreatedProductUser,
  FoundProductUser,
  ProductApiResult,
  ProductProvisioningAdapter,
  ProductProvisioningTarget,
} from './provisioning-adapter';

/**
 * ADR-BE-22 — OpenProject's admin API (HAL v3), used only to create, re-password and lock the
 * accounts the relay signs in as.
 *
 * It is deliberately shallow: three calls, each of which returns a verdict instead of throwing.
 * Provisioning runs on a scheduler pass and must be able to say "the product refused" without the
 * pass dying on the first account — and without a retry that would eventually trip the product's own
 * protections.
 *
 * The token is the instance-scoped admin credential the relay never uses for signing in. It is
 * passed in per call, held only for the duration of the request, and never logged: an error returns
 * a status code and a short tag-stripped message, nothing else.
 */

/** The type this client has always exported; the port names the same object. */
export type ProductApiTarget = ProductProvisioningTarget;

export type { CreatedProductUser, FoundProductUser, ProductApiResult };

@Injectable()
export class ProductApiClient implements ProductProvisioningAdapter {
  readonly name = 'openproject';
  /** OpenProject's API authenticates with a personal access token, not a login pair. */
  readonly credentialKind = 'bearer' as const;
  /**
   * The deploy seeds this administrator and `OPENPROJECT_SEED_ADMIN_USER_PASSWORD_RESET=false` in the
   * entry's env schema keeps the first sign-in from forcing a password change, so the account can be
   * used once to mint the token (ADR-BE-22 §Credentials, amendment). The password is never rotated.
   */
  readonly adminBootstrap = {
    login: 'admin',
    passwordVariable: 'OPENPROJECT_SEED__ADMIN__USER__PASSWORD',
  } as const;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** `POST /api/v3/users`. A login that already exists is the caller's problem to reconcile. */
  async createUser(
    target: ProductApiTarget,
    user: {
      readonly login: string;
      readonly password: string;
      readonly firstName: string;
      readonly lastName: string;
      readonly email: string | null;
    },
  ): Promise<ProductApiResult<CreatedProductUser>> {
    return this.send<CreatedProductUser>(
      target,
      'POST',
      '/api/v3/users',
      {
        login: user.login,
        password: user.password,
        firstName: user.firstName,
        lastName: user.lastName,
        ...(user.email === null ? {} : { email: user.email }),
      },
      (body) => {
        const id = identifierOf(body);
        return id === null ? null : { id, login: user.login };
      },
    );
  }

  /** `PATCH /api/v3/users/:id` with a new password. Used by rotation. */
  async resetPassword(
    target: ProductApiTarget,
    userId: string,
    password: string,
  ): Promise<ProductApiResult<null>> {
    return this.send<null>(
      target,
      'PATCH',
      `/api/v3/users/${encodeURIComponent(userId)}`,
      { password },
      () => null,
    );
  }

  /**
   * `PATCH /api/v3/users/:id` with `status: 'locked'`. Offboarding disables the account rather than
   * deleting it: the product's own history is the attribution the per-user rule exists to protect,
   * and a deleted author loses their name from it.
   */
  async disableUser(target: ProductApiTarget, userId: string): Promise<ProductApiResult<null>> {
    return this.send<null>(
      target,
      'PATCH',
      `/api/v3/users/${encodeURIComponent(userId)}`,
      { status: 'locked' },
      () => null,
    );
  }

  /** `GET /api/v3/users?filters=…` — used to reconcile an account this mapping created earlier. */
  async findUserByLogin(
    target: ProductApiTarget,
    login: string,
  ): Promise<ProductApiResult<FoundProductUser | null>> {
    const filter = JSON.stringify([{ login: { operator: '=', values: [login] } }]);
    return this.send<FoundProductUser | null>(
      target,
      'GET',
      `/api/v3/users?filters=${encodeURIComponent(filter)}`,
      undefined,
      (body) => {
        const elements = nestedArray(body, '_embedded', 'elements');
        const first = elements[0];
        const id = first === undefined ? null : identifierOf(first);
        // OpenProject's user representer always carries `admin`; a missing value is read as "not
        // an administrator" so an older representer does not block reconciliation, while an
        // explicit `true` always does.
        return id === null ? null : { id, admin: first?.['admin'] === true };
      },
    );
  }

  private async send<T>(
    target: ProductApiTarget,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body: Record<string, unknown> | undefined,
    parse: (body: Record<string, unknown>) => T | null,
  ): Promise<ProductApiResult<T>> {
    if (target.credential.kind !== 'bearer') {
      return {
        ok: false,
        status: 0,
        detail: 'this client takes a bearer token, and the target carried a login pair',
      };
    }
    let response: Response;
    try {
      response = await productFetch(`${target.origin}${path}`, {
        method,
        headers: {
          host: new URL(target.publicOrigin).host,
          accept: 'application/json',
          authorization: `Bearer ${target.credential.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.SEAMNEX_RELAY_HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        ok: false,
        status: 0,
        detail: `the product could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (response.status >= 400) {
      return {
        ok: false,
        status: response.status,
        detail: await errorOf(response, passwordOf(body)),
      };
    }
    if (method === 'GET' && response.status === 200) {
      const parsed = await json(response);
      const value = parsed === null ? null : parse(parsed);
      return value === null
        ? { ok: false, status: response.status, detail: 'the answer carried no user' }
        : { ok: true, value };
    }
    if (response.status === 204) return { ok: true, value: null as T };
    const parsed = await json(response);
    const value = parsed === null ? null : parse(parsed);
    if (value === null) {
      // A success without a parseable body is only acceptable for the calls that ignore the answer.
      return method === 'PATCH'
        ? { ok: true, value: null as T }
        : { ok: false, status: response.status, detail: 'the answer carried no user' };
    }
    return { ok: true, value };
  }
}

/** HAL users carry `id` at the top level; a bare resource can also expose it through `_links.self`. */
function identifierOf(body: Record<string, unknown>): string | null {
  const direct = body['id'];
  if (typeof direct === 'number' || typeof direct === 'string') return String(direct);
  const self = body['_links'];
  if (typeof self === 'object' && self !== null) {
    const href = (self as Record<string, unknown>)['self'];
    if (typeof href === 'object' && href !== null) {
      const url = (href as Record<string, unknown>)['href'];
      if (typeof url === 'string') {
        const id = url
          .split('/')
          .filter((part) => part.length > 0)
          .pop();
        if (id !== undefined) return id;
      }
    }
  }
  return null;
}

function nestedArray(
  body: Record<string, unknown>,
  outer: string,
  inner: string,
): Record<string, unknown>[] {
  const first = body[outer];
  if (typeof first !== 'object' || first === null) return [];
  const second = (first as Record<string, unknown>)[inner];
  return Array.isArray(second) ? (second as Record<string, unknown>[]) : [];
}

async function json(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A short, tag-free rendering of the product's refusal, with the submitted password removed.
 *
 * The admin token is a header the product does not echo. The password is a request body, and
 * "OpenProject does not repeat it in an error" is an assumption about the product: a policy `422`
 * re-describes the input, and this string reaches an audit row and a log line. Scrubbing against the
 * value in hand removes the assumption (ADR-BE-22 §Credentials, "exposure").
 */
async function errorOf(response: Response, password: string | undefined): Promise<string> {
  const text = await response.text().catch(() => '');
  const message =
    /"message"\s*:\s*"([^"]{1,240})"/.exec(text)?.[1] ??
    text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  return `answered ${response.status}${message.length === 0 ? '' : `: ${redactValue(message, password)}`}`;
}

/** The credential a request body carries, if it carries one. */
function passwordOf(body: Record<string, unknown> | undefined): string | undefined {
  const password = body?.['password'];
  return typeof password === 'string' && password.length > 0 ? password : undefined;
}
