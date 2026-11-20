import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { AppConfig } from '../../../config/config';
import { productFetch } from '../product-http';
import type {
  CreatedProductUser,
  FoundProductUser,
  ProductAdminCredential,
  ProductApiResult,
  ProductProvisioningAdapter,
  ProductProvisioningTarget,
} from '../provisioning-adapter';

/**
 * ADR-BE-22 §Credentials — D2 Mautic 7.2.2 provisioning, over the product's own REST API.
 *
 * Every fact below was measured on the running 7.2.2 instance on 2026-11-20, because each one is a
 * way a copied OpenProject or OrangeHRM client would fail:
 *
 *   1. **The API is off by default and basic auth is off separately.** `GET /api/users` answers
 *      `403 api_disabled` until `api_enabled` is set in `config/local.php`, then `403` again with
 *      “Basic Auth disabled” until `api_enable_basic_auth` is too. The render set now writes both
 *      (`seamnex-bootstrap.sh`), and the refusal here names them so an operator can act.
 *   2. **Basic auth is the whole session.** Unlike OrangeHRM there is no form to drive for the API:
 *      the administrator's login pair in an `Authorization: Basic` header answers every call, so
 *      this client holds no session and needs no re-sign-in path.
 *   3. **A listing is `{"total":n,"users":[…]}`, and exact match is the `where` grammar** —
 *      `?where[0][col]=username&where[0][expr]=eq&where[0][val]=…` returned one row for a real login
 *      and `{"total":0,"users":[]}` for a miss. `?search=` is a fuzzy filter and would let a
 *      `jdoe` lookup adopt `jdoe2`, which is the collision the ADR refuses.
 *   4. **`PATCH /api/users/{id}/edit` accepts `plainPassword` and silently drops it.** Measured: the
 *      response is `200` with the unchanged record, the “changed” password does not sign in and the
 *      original still does — the API's own source says so (“Changing passwords via API is
 *      forbidden”). A rotation built on `PATCH` would therefore store a password the product never
 *      accepted and take the mapping down at the next launch instead of at the next rotation.
 *      `resetPassword` therefore replaces the account (delete + create, both measured), which is the
 *      only path that actually re-passwords a Mautic user.
 *   5. **Disabling is `isPublished: false` through `PATCH`.** Measured: the record keeps its history,
 *      and the form then answers `302 → /s/login`, which the driver already reports as
 *      `credential_rejected`. Re-enabling restores the same account.
 *   6. **A fresh install ships only the Administrator role.** Provisioned accounts get a
 *      non-administrator role named `Relay` with no permissions — measured: signing in with it
 *      reaches `/s/dashboard` (two hops, the second answers `200`), which is the least privilege
 *      that can hold a session. The role is reused when it exists; an existing *administrator* role
 *      of that name is refused rather than assigned.
 */

/** The only role this client will ever assign. Created once per instance, never privileged. */
const RELAY_ROLE_NAME = 'Relay';
const RELAY_ROLE_DESCRIPTION = 'Relay-managed sign-in accounts';

const USERS_PATH = '/api/users';
const ROLES_PATH = '/api/roles';

/** How long the role lookup is trusted before the product is asked again. */
const ROLE_TTL_MS = 10 * 60 * 1_000;

type RoleRef = { readonly id: number; readonly admin: boolean };

@Injectable()
export class MauticApiClient implements ProductProvisioningAdapter {
  readonly name = 'mautic';
  readonly credentialKind = 'password' as const;
  readonly passwordVariables = {
    username: 'MAUTIC_ADMIN_USERNAME',
    password: 'MAUTIC_ADMIN_PASSWORD',
  };

  private readonly logger = new Logger('m24-mautic-api');
  /** Keyed by internal origin: one instance's role id never answers for another. */
  private readonly roles = new Map<string, { id: number; expiresAt: number }>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * `POST /api/users/new`. The password travels once, in `plainPassword`, because the API accepts it
   * on create and only on create.
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
    const role = await this.role(target);
    if (!role.ok) return role;

    const created = await this.send<{ user?: { id?: number } }>(
      target,
      'POST',
      `${USERS_PATH}/new`,
      {
        username: user.login,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email ?? `${user.login}@${new URL(target.publicOrigin).hostname}`,
        plainPassword: { password: user.password, confirm: user.password },
        role: role.value.id,
        isPublished: 1,
      },
    );
    if (!created.ok) return created;

    const id = created.value.user?.id;
    if (typeof id !== 'number') {
      return { ok: false, status: 0, detail: 'the product created no user record' };
    }
    return { ok: true, value: { id: String(id), login: user.login } };
  }

  /**
   * Re-password by replacement.
   *
   * `PATCH` is not an option: it answers `200` and ignores the password (measured, and stated in the
   * controller). The account is read first so the replacement keeps the same login, address, name
   * and role; the delete then fails the old credential immediately, which is what a rotation is for.
   */
  async resetPassword(
    target: ProductProvisioningTarget,
    userId: string,
    password: string,
  ): Promise<ProductApiResult<null>> {
    const current = await this.user(target, userId);
    if (!current.ok) return current;

    const removed = await this.send<unknown>(
      target,
      'DELETE',
      `${USERS_PATH}/${encodeURIComponent(userId)}/delete`,
      undefined,
    );
    if (!removed.ok) return removed;

    const recreated = await this.send<{ user?: { id?: number } }>(
      target,
      'POST',
      `${USERS_PATH}/new`,
      {
        username: current.value.username,
        firstName: current.value.firstName,
        lastName: current.value.lastName,
        email: current.value.email,
        plainPassword: { password, confirm: password },
        role: current.value.role,
        isPublished: 1,
      },
    );
    if (!recreated.ok) return recreated;
    if (typeof recreated.value.user?.id !== 'number') {
      return {
        ok: false,
        status: 0,
        detail: 'the product removed the account but created no replacement',
      };
    }
    this.logger.log(
      `rotated the Mautic account ${current.value.username} on ${target.publicOrigin} by replacement`,
    );
    return { ok: true, value: null };
  }

  /** `PATCH /api/users/{id}/edit` with `isPublished: false` — locked, never deleted. */
  async disableUser(
    target: ProductProvisioningTarget,
    userId: string,
  ): Promise<ProductApiResult<null>> {
    return this.send<null>(target, 'PATCH', `${USERS_PATH}/${encodeURIComponent(userId)}/edit`, {
      isPublished: false,
    });
  }

  /**
   * The product's own exact-match filter, and `admin` from the role it reports.
   *
   * A row without a role object is not an administrator: `isAdmin` is only ever the product's
   * affirmative answer, because a false positive here refuses a legitimate mapping and a false
   * negative would adopt an administrator.
   */
  async findUserByLogin(
    target: ProductProvisioningTarget,
    login: string,
  ): Promise<ProductApiResult<FoundProductUser | null>> {
    const query = [
      'where[0][col]=username',
      'where[0][expr]=eq',
      `where[0][val]=${encodeURIComponent(login)}`,
      'limit=1',
    ].join('&');
    const found = await this.send<{
      users?: { id?: number; role?: { isAdmin?: boolean } | null }[];
    }>(target, 'GET', `${USERS_PATH}?${query}`, undefined);
    if (!found.ok) return found;

    const first = found.value.users?.[0];
    if (first === undefined || typeof first.id !== 'number') return { ok: true, value: null };
    return {
      ok: true,
      value: { id: String(first.id), admin: first.role?.isAdmin === true },
    };
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * The non-administrator role provisioned accounts receive, created on first use.
   *
   * A role that exists under the same name but is an administrator is refused: the platform must
   * never sign a person in with rights it did not grant, and the ADR's least-privilege rule is the
   * reason this client creates a role with no permissions at all rather than reusing one.
   */
  private async role(target: ProductProvisioningTarget): Promise<ProductApiResult<RoleRef>> {
    const cached = this.roles.get(target.origin);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return { ok: true, value: { id: cached.id, admin: false } };
    }

    const listed = await this.listRole(target);
    if (!listed.ok) return listed;

    let role = listed.value;
    if (role === null) {
      const created = await this.send<{ role?: { id?: number; isAdmin?: boolean } }>(
        target,
        'POST',
        `${ROLES_PATH}/new`,
        {
          name: RELAY_ROLE_NAME,
          description: RELAY_ROLE_DESCRIPTION,
          isAdmin: false,
          isPublished: true,
          rawPermissions: [],
        },
      );
      if (created.ok && typeof created.value.role?.id === 'number') {
        role = { id: created.value.role.id, admin: created.value.role.isAdmin === true };
      } else {
        // Two passes can race to create it; the second sees the product's duplicate answer. Read
        // again before calling the pass failed — the role the other pass made is the one we want.
        const retry = await this.listRole(target);
        if (!retry.ok) {
          return created.ok
            ? { ok: false, status: 0, detail: `the product created no ${RELAY_ROLE_NAME} role` }
            : { ok: false, status: created.status, detail: created.detail };
        }
        role = retry.value;
      }
    }

    if (role === null) {
      return {
        ok: false,
        status: 0,
        detail: `the product did not expose a ${RELAY_ROLE_NAME} role`,
      };
    }
    if (role.admin) {
      return {
        ok: false,
        status: 0,
        detail: `the product's ${RELAY_ROLE_NAME} role is an administrator; the relay will not assign it`,
      };
    }

    this.roles.set(target.origin, { id: role.id, expiresAt: Date.now() + ROLE_TTL_MS });
    return { ok: true, value: role };
  }

  private async listRole(
    target: ProductProvisioningTarget,
  ): Promise<ProductApiResult<RoleRef | null>> {
    const listed = await this.send<{
      roles?: { id?: number; name?: string; isAdmin?: boolean }[];
    }>(target, 'GET', `${ROLES_PATH}?limit=100`, undefined);
    if (!listed.ok) return listed;

    const match = (listed.value.roles ?? []).find(
      (role) =>
        typeof role.name === 'string' && role.name.toLowerCase() === RELAY_ROLE_NAME.toLowerCase(),
    );
    if (match === undefined || typeof match.id !== 'number') return { ok: true, value: null };
    return { ok: true, value: { id: match.id, admin: match.isAdmin === true } };
  }

  /** The fields a replacement must reproduce; `role` is the id the form expects. */
  private async user(
    target: ProductProvisioningTarget,
    userId: string,
  ): Promise<
    ProductApiResult<{
      username: string;
      firstName: string;
      lastName: string;
      email: string;
      role: number;
    }>
  > {
    const row = await this.send<{
      user?: {
        username?: string;
        firstName?: string;
        lastName?: string;
        email?: string;
        role?: { id?: number } | null;
      };
    }>(target, 'GET', `${USERS_PATH}/${encodeURIComponent(userId)}`, undefined);
    if (!row.ok) return row;

    const user = row.value.user;
    const role = user?.role?.id;
    if (
      typeof user?.username !== 'string' ||
      typeof user.firstName !== 'string' ||
      typeof user.lastName !== 'string' ||
      typeof user.email !== 'string' ||
      typeof role !== 'number'
    ) {
      return {
        ok: false,
        status: 0,
        detail: 'the product described the account without the fields a replacement requires',
      };
    }
    return {
      ok: true,
      value: {
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role,
      },
    };
  }

  /** One JSON call with the administrator's login pair. Never carries a per-user credential. */
  private async send<T>(
    target: ProductProvisioningTarget,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body: Record<string, unknown> | undefined,
  ): Promise<ProductApiResult<T>> {
    if (target.credential.kind !== 'password') {
      return {
        ok: false,
        status: 0,
        detail: 'this client takes an administrator login pair, and the target carried a token',
      };
    }

    let response: Response;
    try {
      response = await productFetch(`${target.origin}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          host: new URL(target.publicOrigin).host,
          /*
           * The product is reached over plain HTTP on the instance network, but its `site_url` is the
           * https route; the header is what the edge would send, and it keeps every absolute URL the
           * product builds on the address the browser can open.
           */
          'x-forwarded-proto': new URL(target.publicOrigin).protocol.replace(':', ''),
          accept: 'application/json',
          authorization: basic(target.credential),
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
      return { ok: false, status: response.status, detail: await errorOf(response) };
    }
    const parsed = await json(response);
    if (parsed === null) return { ok: true, value: undefined as T };
    return { ok: true, value: parsed as T };
  }
}

/** `Basic base64(user:password)`; the pair is read from the instance secret for this call only. */
function basic(credential: Extract<ProductAdminCredential, { kind: 'password' }>): string {
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64')}`;
}

async function json(response: Response): Promise<Record<string, unknown> | null> {
  const body = await response.text().catch(() => '');
  if (body.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The product's refusal, with the two switches an operator has to flip named explicitly.
 *
 * Mautic answers `{"errors":[{"message":"API disabled…","code":403,"type":"api_disabled"}]}` and then
 * a second `403` for basic auth. Reproducing only the message leaves an operator with a log line and
 * no action; the two `config/local.php` keys are the action.
 */
async function errorOf(response: Response): Promise<string> {
  const body = await json(response);
  const first = (body?.['errors'] as unknown[] | undefined)?.[0];
  const message =
    typeof first === 'object' &&
    first !== null &&
    typeof (first as { message?: unknown }).message === 'string'
      ? (first as { message: string }).message
      : null;

  if (message !== null && /api disabled/i.test(message)) {
    return 'the product API is off: set api_enabled in config/local.php and deploy again';
  }
  if (message !== null && /basic auth disabled/i.test(message)) {
    return 'the product API refuses basic auth: set api_enable_basic_auth in config/local.php and deploy again';
  }
  return message === null
    ? `answered ${response.status}`
    : `answered ${response.status}: ${message}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
