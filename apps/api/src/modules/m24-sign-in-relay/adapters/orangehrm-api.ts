import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { AppConfig } from '../../../config/config';
import { productFetch } from '../product-http';
import { cookieHeader, jarFromCookies } from './shared';
import { orangeHrmLogin } from './orangehrm-login';
import type {
  CreatedProductUser,
  FoundProductUser,
  ProductApiResult,
  ProductProvisioningAdapter,
  ProductProvisioningTarget,
} from '../provisioning-adapter';

/**
 * ADR-BE-22 §Credentials — D7 OrangeHRM 5.9 provisioning, over the product's own REST API v2.
 *
 * Three facts shape this file, all measured on the running instance:
 *
 *   1. **The API takes a session, not a token.** `/api/v2/…` answers to the same `_orangehrm` cookie
 *      the desktop UI uses (verified: `GET`, `POST` and `PUT` all succeed with it). There is no
 *      personal-access-token equivalent to OpenProject's, and the OAuth2 client the vendor documents
 *      is not registered on a fresh install (`ohrm_oauth2_client` is empty). Rather than invent a
 *      second operator-supplied credential, the adapter signs in as the administrator the installer
 *      already created — the instance's own `ORANGEHRM_ADMIN_USERNAME` / `ORANGEHRM_ADMIN_PASSWORD`,
 *      which the platform holds as instance secrets. Nothing new for an operator to configure.
 *   2. **A user needs an employee.** `empNumber` is a required create parameter, so provisioning
 *      creates the employee record first and removes it again if the user could not be attached.
 *   3. **`changePassword` decides whether `password` may appear at all.** The update endpoint
 *      rejects an unknown key with `422 invalidParamKeys`, so rotation sends `changePassword: true`
 *      with a password and disabling sends `changePassword: false` without one. Measured both ways.
 *
 * The administrator's session is held only in memory, for the length of a sweep, and is dropped on
 * the first 401 — a cached credential that stopped working must cost one request, not every row.
 */

/** `ohrm_user_role`: 1 Admin, 2 ESS. Provisioned accounts are ESS: least privilege, never an admin. */
const ESS_ROLE_ID = 2;

const EMPLOYEES_PATH = '/web/index.php/api/v2/pim/employees';
const USERS_PATH = '/web/index.php/api/v2/admin/users';

/** How long the administrator's API session is trusted before it is re-established. */
const SESSION_TTL_MS = 10 * 60 * 1_000;

type AdminSession = { readonly cookie: string; readonly expiresAt: number };

@Injectable()
export class OrangeHrmApiClient implements ProductProvisioningAdapter {
  readonly name = 'orangehrm';
  readonly credentialKind = 'password' as const;
  readonly passwordVariables = {
    username: 'ORANGEHRM_ADMIN_USERNAME',
    password: 'ORANGEHRM_ADMIN_PASSWORD',
  };

  private readonly logger = new Logger('m24-orangehrm-api');
  /** Keyed by internal origin: one instance's administrator session never answers for another. */
  private readonly sessions = new Map<string, AdminSession>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * `POST /api/v2/pim/employees`, then `POST /api/v2/admin/users`.
   *
   * The employee is created with the platform's own first/last name for the person, because the
   * product displays the employee — not the login — in every screen that records work.
   */
  async createUser(
    target: ProductProvisioningTarget,
    user: {
      readonly login: string;
      readonly password: string;
      readonly firstName: string;
      readonly lastName: string;
      readonly email: string | null;
    },
  ): Promise<ProductApiResult<CreatedProductUser>> {
    const employee = await this.send<{ empNumber: number }>(target, 'POST', EMPLOYEES_PATH, {
      firstName: user.firstName,
      lastName: user.lastName,
    });
    if (!employee.ok) return employee;
    if (typeof employee.value.empNumber !== 'number') {
      return { ok: false, status: 0, detail: 'the product created no employee record' };
    }

    const created = await this.send<{ id: number }>(target, 'POST', USERS_PATH, {
      username: user.login,
      password: user.password,
      status: true,
      userRoleId: ESS_ROLE_ID,
      empNumber: employee.value.empNumber,
    });
    if (!created.ok) {
      /*
       * Best effort, and never the reason the pass fails: an employee with no user is invisible in
       * the product's own user list, but leaving one behind per failed pass is how an HR database
       * fills with people the platform invented.
       */
      await this.send<null>(target, 'DELETE', EMPLOYEES_PATH, { ids: [employee.value.empNumber] });
      return created;
    }
    if (typeof created.value.id !== 'number') {
      return { ok: false, status: 0, detail: 'the product created no user record' };
    }
    return { ok: true, value: { id: String(created.value.id), login: user.login } };
  }

  /** `PUT /api/v2/admin/users/:id` with `changePassword: true` and the new value. */
  async resetPassword(
    target: ProductProvisioningTarget,
    userId: string,
    password: string,
  ): Promise<ProductApiResult<null>> {
    const current = await this.user(target, userId);
    if (!current.ok) return current;
    return this.send<null>(target, 'PUT', `${USERS_PATH}/${encodeURIComponent(userId)}`, {
      ...current.value,
      changePassword: true,
      password,
    });
  }

  /**
   * `PUT /api/v2/admin/users/:id` with `status: false` — locked, never deleted: the product's own
   * history is the attribution the per-user rule exists to protect.
   *
   * `password` is a **required key on update whatever `changePassword` says** — `changePassword`
   * only switches the strength rule off, not the requirement (`UserAPI::getValidationRuleForUpdate`
   * always adds the `ParamRule`). The product's own edit form therefore sends `password: ''` when
   * "change password" is unchecked, and `setUserParams` ignores the value. Sending the same thing is
   * what makes a lock possible without knowing the account's current password.
   */
  async disableUser(
    target: ProductProvisioningTarget,
    userId: string,
  ): Promise<ProductApiResult<null>> {
    const current = await this.user(target, userId);
    if (!current.ok) return current;
    return this.send<null>(target, 'PUT', `${USERS_PATH}/${encodeURIComponent(userId)}`, {
      ...current.value,
      changePassword: false,
      password: '',
      status: false,
    });
  }

  /**
   * `GET /api/v2/admin/users?username=…` — the product's own exact-match filter.
   *
   * `admin` is derived from the role the product reports, not assumed: a collision against an
   * administrator account must be refused by the caller, and this is the only place that knows.
   */
  async findUserByLogin(
    target: ProductProvisioningTarget,
    login: string,
  ): Promise<ProductApiResult<FoundProductUser | null>> {
    const found = await this.send<{ id: number; userRole?: { name?: string } }[]>(
      target,
      'GET',
      `${USERS_PATH}?username=${encodeURIComponent(login)}`,
      undefined,
    );
    if (!found.ok) return found;
    const first = found.value[0];
    if (first === undefined || typeof first.id !== 'number') return { ok: true, value: null };
    return {
      ok: true,
      value: { id: String(first.id), admin: first.userRole?.name === 'Admin' },
    };
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * The body the update endpoint insists on. `setUserParams` reads every field unconditionally and
   * the validator rejects unknown keys, so a partial update is not a partial update here: it is a
   * `422`. Reading the record first is what makes rotation and disable possible at all.
   */
  private async user(
    target: ProductProvisioningTarget,
    userId: string,
  ): Promise<
    ProductApiResult<{
      username: string;
      status: boolean;
      userRoleId: number;
      empNumber: number;
    }>
  > {
    const row = await this.send<{
      userName?: string;
      status?: boolean;
      userRole?: { id?: number };
      employee?: { empNumber?: number };
    }>(target, 'GET', `${USERS_PATH}/${encodeURIComponent(userId)}`, undefined);
    if (!row.ok) return row;

    const { userName, status, userRole, employee } = row.value;
    const empNumber = employee?.empNumber;
    const userRoleId = userRole?.id;
    if (
      typeof userName !== 'string' ||
      typeof status !== 'boolean' ||
      typeof userRoleId !== 'number' ||
      typeof empNumber !== 'number'
    ) {
      return {
        ok: false,
        status: 0,
        detail: 'the product described the account without the fields an update requires',
      };
    }
    return { ok: true, value: { username: userName, status, userRoleId, empNumber } };
  }

  /** One JSON call with the administrator's session, re-established once if the product drops it. */
  private async send<T>(
    target: ProductProvisioningTarget,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: Record<string, unknown> | undefined,
  ): Promise<ProductApiResult<T>> {
    const first = await this.call<T>(target, method, path, body, false);
    if (first.ok || first.status !== 401) return first;
    // A session that expired between passes is a cache miss, not a product failure.
    this.sessions.delete(target.origin);
    return this.call<T>(target, method, path, body, true);
  }

  private async call<T>(
    target: ProductProvisioningTarget,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: Record<string, unknown> | undefined,
    asRetry: boolean,
  ): Promise<ProductApiResult<T>> {
    if (target.credential.kind !== 'password') {
      return {
        ok: false,
        status: 0,
        detail: 'this client takes an administrator login pair, and the target carried a token',
      };
    }
    let session: AdminSession;
    try {
      session = await this.session(target);
    } catch (error) {
      return {
        ok: false,
        status: 0,
        detail: `the administrator could not sign in: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let response: Response;
    try {
      response = await productFetch(`${target.origin}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          host: new URL(target.publicOrigin).host,
          accept: 'application/json',
          cookie: session.cookie,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.config.SEAMNEX_RELAY_HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        ok: false,
        status: 0,
        detail: `the product could not be reached: ${messageOf(error)}`,
      };
    }

    if (response.status >= 400) {
      if (!asRetry) this.sessions.delete(target.origin);
      return { ok: false, status: response.status, detail: await errorOf(response) };
    }
    const parsed = await json(response);
    if (parsed === null) {
      // A 200 with no body is only a success for DELETE, which the caller ignores anyway.
      return { ok: true, value: undefined as T };
    }
    return { ok: true, value: unwrap(parsed) as T };
  }

  /**
   * Sign the administrator in through the product's own form — the same code path the relay uses
   * for a person, because a second implementation of that form is a second thing to break on an
   * upgrade. The session lives in this process only.
   */
  private async session(target: ProductProvisioningTarget): Promise<AdminSession> {
    const cached = this.sessions.get(target.origin);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached;
    if (target.credential.kind !== 'password') throw new Error('no administrator login pair');
    this.sessions.delete(target.origin);

    const result = await orangeHrmLogin.signIn(
      {
        origin: target.origin,
        publicOrigin: target.publicOrigin,
        username: target.credential.username,
        credential: target.credential.password,
      },
      { timeoutMs: this.config.SEAMNEX_RELAY_HTTP_TIMEOUT_MS },
    );
    if (!result.ok) {
      this.logger.warn(`the OrangeHRM administrator sign-in failed: ${result.reason}`);
      throw new Error(result.reason);
    }
    const session: AdminSession = {
      cookie: cookieHeader(jarFromCookies(result.cookies).values),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    this.sessions.set(target.origin, session);
    return session;
  }
}

/** OrangeHRM answers `{ data: … }`; every call here is interested in that member. */
function unwrap(body: Record<string, unknown>): unknown {
  return body['data'] ?? body;
}

async function json(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text().catch(() => '');
  if (text.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A short, tag-free rendering of the product's refusal.
 *
 * OrangeHRM reports `{"error":{"status":422,"message":"Invalid Parameter","data":{…}}}`, and the
 * `invalidParamKeys` list is the actionable part — a rotation that fails on a body the product does
 * not accept must say which key it rejected.
 */
async function errorOf(response: Response): Promise<string> {
  const body = await json(response);
  const error = body?.['error'];
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const message = typeof record['message'] === 'string' ? record['message'] : 'refused';
    const invalid = (record['data'] as Record<string, unknown> | undefined)?.['invalidParamKeys'];
    const keys = Array.isArray(invalid) ? ` (${invalid.join(', ')})` : '';
    return `answered ${response.status}: ${message}${keys}`;
  }
  return `answered ${response.status}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
