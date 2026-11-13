import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { OrangeHrmApiClient } from '../../../../src/modules/m24-sign-in-relay/adapters/orangehrm-api';
import { ProductApiClient } from '../../../../src/modules/m24-sign-in-relay/product-api.client';
import { ProductApiAdapters } from '../../../../src/modules/m24-sign-in-relay/provisioning-adapters';
import type {
  CreatedProductUser,
  FoundProductUser,
  ProductAdminCredential,
  ProductApiResult,
  ProductProvisioningAdapter,
  ProductProvisioningTarget,
} from '../../../../src/modules/m24-sign-in-relay/provisioning-adapter';

/**
 * The second seam (ADR-BE-22 §Credentials): the four verbs that create, re-password and lock the
 * per-user accounts the relay signs in as.
 *
 * The module is declaration-only, so there is no function here to call. What has to hold is the
 * contract the two shipped clients are written against, and two of its clauses are load-bearing:
 *
 *   * **A product cannot be handed the wrong half of the credential.** The union is what makes the
 *     caller read one shape from the secret store, and both clients must refuse the other rather
 *     than send it. A bearer token presented to OrangeHRM, or an administrator's login pair sent to
 *     OpenProject, is a credential disclosed to the wrong product.
 *   * **`credentialKind` must describe the descriptor an adapter declares.** A `password` product
 *     without `passwordVariables` is unprovisionable, and the sweep reports it as
 *     `admin_credential_missing` on every pass — visible, but with no cause an operator can act on.
 *
 * The transport is stubbed, not `globalThis.fetch`: `productFetch` is the seam the clients actually
 * use, so a test that stubbed the global would be bypassed and would prove nothing.
 */
const { productFetchMock } = vi.hoisted(() => ({ productFetchMock: vi.fn() }));
vi.mock('../../../../src/modules/m24-sign-in-relay/product-http', () => ({
  productFetch: productFetchMock,
}));

const config = { SEAMNEX_RELAY_HTTP_TIMEOUT_MS: 1_000 } as unknown as AppConfig;

/**
 * Both shipped adapters, constructed the way the module wires them, then widened to the port: the
 * tests below ask what the *contract* promises, and only the port declares `passwordVariables`.
 */
function adapters(): {
  openproject: ProductProvisioningAdapter;
  orangehrm: ProductProvisioningAdapter;
  registry: ProductApiAdapters;
} {
  const openproject = new ProductApiClient(config);
  const orangehrm = new OrangeHrmApiClient(config);
  return { openproject, orangehrm, registry: new ProductApiAdapters(openproject, orangehrm) };
}

const target: ProductProvisioningTarget = {
  origin: 'http://openproject:80',
  publicOrigin: 'http://openproject.localhost:8020',
  credential: { kind: 'bearer', token: 'admin-token' },
};

const user = {
  login: 'jdoe',
  password: 'hunter2-battery',
  firstName: 'Jane',
  lastName: 'Doe',
  email: null,
};

/** A caller's view of the union: it accepts a credential, never a credential and a half. */
const accept = (credential: ProductAdminCredential): ProductAdminCredential => credential;

/** Built by a function so the verdict's `ok` stays `boolean` and both branches are reachable. */
function created(): ProductApiResult<CreatedProductUser> {
  return { ok: true, value: { id: '9', login: 'jdoe' } };
}

afterEach(() => {
  productFetchMock.mockReset();
});

describe('provisioning-adapter', () => {
  it('is declaration-only: the compiler erases it and nothing runs', async () => {
    // Pinned like the other type-only modules, so a runtime export added here is a decision rather
    // than an accident — every consumer imports this file through `import type`.
    const module: Record<string, unknown> =
      await import('../../../../src/modules/m24-sign-in-relay/provisioning-adapter');

    expect(Object.keys(module)).toEqual([]);
  });

  it('cannot carry both halves of the admin credential', () => {
    // Each half on its own is a credential; both at once is the mistake this union exists to stop,
    // and it is a compile error at the call site rather than a runtime check.
    expectTypeOf<{ kind: 'bearer'; token: string }>().toExtend<ProductAdminCredential>();
    expectTypeOf<{
      kind: 'password';
      username: string;
      password: string;
    }>().toExtend<ProductAdminCredential>();
    expectTypeOf<ProductAdminCredential['kind']>().toEqualTypeOf<'bearer' | 'password'>();
    expectTypeOf(accept).parameter(0).toEqualTypeOf<ProductAdminCredential>();

    // @ts-expect-error a bearer credential cannot also carry an administrator's login pair
    accept({ kind: 'bearer', token: 'admin-token', username: 'admin', password: 'secret' });
  });

  it('narrows a verdict instead of throwing, so one refusal cannot end a sweep', () => {
    const verdict = created();

    if (verdict.ok) {
      expectTypeOf(verdict.value).toEqualTypeOf<CreatedProductUser>();
      expect(verdict.value.login).toBe('jdoe');
    } else {
      expectTypeOf(verdict.detail).toEqualTypeOf<string>();
    }

    // `admin` is read to refuse a login collision, so it is required and boolean — never optional,
    // or "not an administrator" and "the product did not say" become the same answer.
    expectTypeOf<FoundProductUser>().toExtend<{ readonly id: string; readonly admin: boolean }>();
  });

  it('declares, per adapter, the credential shape that product accepts', () => {
    const { openproject, orangehrm } = adapters();

    // OpenProject: one instance-scoped personal access token, named by config.
    expect(openproject.credentialKind).toBe('bearer');
    expect(openproject.passwordVariables).toBeUndefined();
    expect(openproject.name).toBe('openproject');

    // OrangeHRM: the installer's administrator login, held as an instance secret — the variable
    // names belong to the product's env schema, which is why the adapter names them.
    expect(orangehrm.credentialKind).toBe('password');
    expect(orangehrm.passwordVariables).toEqual({
      username: 'ORANGEHRM_ADMIN_USERNAME',
      password: 'ORANGEHRM_ADMIN_PASSWORD',
    });
    expect(orangehrm.name).toBe('orangehrm');
  });

  it('gives every registered adapter a credential descriptor it can actually be handed', () => {
    const { registry } = adapters();
    const entries = ['D09-01', 'D07-01', 'D9', 'D7'];

    const registered = entries.map((entry) => registry.for(entry));
    expect(registered.every((adapter) => adapter !== null)).toBe(true);

    for (const adapter of registered as ProductProvisioningAdapter[]) {
      if (adapter.credentialKind === 'password') {
        // Without the pair the sweep can only report `admin_credential_missing`: the adapter has
        // said what it takes and cannot say where to find it.
        expect(adapter.passwordVariables).toBeDefined();
        expect(adapter.passwordVariables?.username.length).toBeGreaterThan(0);
        expect(adapter.passwordVariables?.password.length).toBeGreaterThan(0);
      } else {
        // A bearer product reads its token from `SEAMNEX_RELAY_ADMIN_SECRET_NAME`; declaring
        // variables here would ask the operator to configure something nothing reads.
        expect(adapter.passwordVariables).toBeUndefined();
      }
    }
  });

  it('refuses the wrong half instead of sending it to the product', async () => {
    const { openproject, orangehrm } = adapters();

    const toTokenProduct = await openproject.createUser(
      { ...target, credential: { kind: 'password', username: 'admin', password: 'x' } },
      user,
    );
    const toPasswordProduct = await orangehrm.createUser(
      { ...target, credential: { kind: 'bearer', token: 'admin-token' } },
      user,
    );

    expect(toTokenProduct).toEqual({
      ok: false,
      status: 0,
      detail: expect.stringContaining('bearer token'),
    });
    expect(toPasswordProduct).toEqual({
      ok: false,
      status: 0,
      detail: expect.stringContaining('administrator login pair'),
    });
    // `status: 0` is "never asked", and the transport proves it: neither credential reached a
    // socket, so neither product can have logged the other product's secret.
    expect(productFetchMock).not.toHaveBeenCalled();
  });

  it('applies the wrong-half refusal to every verb, not only to create', async () => {
    const { openproject, orangehrm } = adapters();
    const pair: ProductProvisioningTarget = {
      ...target,
      credential: { kind: 'password', username: 'admin', password: 'x' },
    };
    const token: ProductProvisioningTarget = {
      ...target,
      credential: { kind: 'bearer', token: 't' },
    };

    const verdicts = await Promise.all([
      openproject.findUserByLogin(pair, 'jdoe'),
      openproject.resetPassword(pair, '9', 'next-password'),
      openproject.disableUser(pair, '9'),
      orangehrm.findUserByLogin(token, 'jdoe'),
      orangehrm.resetPassword(token, '9', 'next-password'),
      orangehrm.disableUser(token, '9'),
    ]);

    for (const verdict of verdicts) {
      expect(verdict).toMatchObject({ ok: false, status: 0 });
    }
    expect(productFetchMock).not.toHaveBeenCalled();
  });
});
