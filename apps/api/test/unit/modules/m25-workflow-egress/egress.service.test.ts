import { describe, expect, it, vi } from 'vitest';
import { BrokerEgressService } from '../../../../src/modules/m25-workflow-egress/egress.service';

/**
 * The broker is the only path from a workflow to a product, so every refusal it can make is a rule
 * that keeps one workflow from using another's credential, a read token from writing, or the
 * platform from calling an endpoint nobody measured.
 *
 * These tests stop before the product call: each case is answered from the token, the scope and the
 * catalog, which is exactly where a refusal has to come from.
 */
const TARGET = {
  instance_id: 'inst-1',
  entry_key: 'D07-01',
  slug: 'orangehrm',
  payload: { httpPort: 80 },
  host: 'orangehrm.localhost',
  operations: [
    {
      id: 'employees.read',
      mode: 'read',
      path: '/web/index.php/api/v2/pim/employees',
      method: 'GET',
    },
    {
      id: 'leave.write',
      mode: 'write',
      path: '/web/index.php/api/v2/leave/leave-requests',
      method: 'POST',
    },
    { id: 'undocumented.read', mode: 'read' },
  ],
};

function setup(
  options: {
    scope?: Record<string, unknown> | null;
    target?: Record<string, unknown> | null;
  } = {},
) {
  const scope =
    options.scope === undefined
      ? {
          scopeId: 'scope-1',
          instanceId: 'inst-1',
          workflowId: 'wf-1',
          versionId: 'v1',
          operations: ['employees.read', 'leave.write', 'undocumented.read'],
          mode: 'write' as const,
          expiresAt: '2030-01-01T00:00:00.000Z',
        }
      : options.scope;
  const broker = { verifyToken: vi.fn(async () => scope) };
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM instance i')) {
        const row = options.target === undefined ? TARGET : options.target;
        return { rows: row === null ? [] : [row] };
      }
      return { rows: [] };
    }),
  };
  const audit = { append: vi.fn(async () => undefined) };
  const docker = { connectNetwork: vi.fn(async () => undefined) };
  const config = {
    SEAMNEX_EGRESS_TIMEOUT_MS: 5_000,
    SEAMNEX_PRODUCT_URL_SCHEME: 'http',
    SEAMNEX_PRODUCT_URL_PORT: '8020',
    SEAMNEX_RELAY_HTTP_TIMEOUT_MS: 1_000,
    SEAMNEX_RELAY_CONTAINER: '',
  };
  const service = new BrokerEgressService(
    pool as never,
    config as never,
    audit as never,
    { find: vi.fn(), open: vi.fn() } as never,
    broker as never,
    docker as never,
  );
  return { service, broker, pool, audit, docker };
}

const READ = {
  token: 'seamnex_token',
  entryKey: 'D07-01',
  operation: 'employees.read',
  method: 'GET',
  query: '',
  contentType: null,
  accept: null,
  body: null,
};

describe('broker egress', () => {
  it('refuses a call with no token, and audits the refusal', async () => {
    const { service, broker, audit } = setup();

    const result = await service.forward({ ...READ, token: null });

    expect(result.status).toBe(401);
    expect(result.body?.toString()).toContain('carried no token');
    // No token means no lookup: the broker must not even ask the scope table.
    expect(broker.verifyToken).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.egress',
        outcome: 'failure',
        detail: expect.objectContaining({ status: 401 }),
      }),
    );
  });

  it('refuses a token that is unknown, expired, revoked or from a superseded version', async () => {
    const { service } = setup({ scope: null });

    const result = await service.forward(READ);

    expect(result.status).toBe(401);
    expect(result.body?.toString()).toContain('moved past');
  });

  it('refuses an operation the token does not cover', async () => {
    const { service } = setup({
      scope: {
        scopeId: 'scope-1',
        instanceId: 'inst-1',
        workflowId: 'wf-1',
        versionId: 'v1',
        operations: ['employees.read'],
        mode: 'read',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
    });

    const result = await service.forward({ ...READ, operation: 'leave.write', method: 'POST' });

    expect(result.status).toBe(403);
    expect(result.body?.toString()).toContain('does not cover operation');
  });

  it('refuses a token minted for another product', async () => {
    const { service } = setup();

    const result = await service.forward({ ...READ, entryKey: 'D01-01' });

    expect(result.status).toBe(403);
    expect(result.body?.toString()).toContain('authorises D07-01');
  });

  it('refuses an operation whose endpoint was never recorded', async () => {
    const { service } = setup();

    const result = await service.forward({ ...READ, operation: 'undocumented.read' });

    expect(result.status).toBe(409);
    expect(result.body?.toString()).toContain('declares no path and method');
  });

  it('refuses a verb that disagrees with the catalog', async () => {
    const { service } = setup();

    const result = await service.forward({ ...READ, method: 'POST' });

    expect(result.status).toBe(405);
    expect(result.body?.toString()).toContain('called with GET');
  });

  it('refuses a write from a read-only token', async () => {
    const { service } = setup({
      scope: {
        scopeId: 'scope-1',
        instanceId: 'inst-1',
        workflowId: 'wf-1',
        versionId: 'v1',
        operations: ['leave.write'],
        mode: 'read',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
    });

    const result = await service.forward({
      ...READ,
      operation: 'leave.write',
      method: 'POST',
    });

    expect(result.status).toBe(403);
    expect(result.body?.toString()).toContain('read-only');
  });

  it('answers 404 when the product behind the token is gone', async () => {
    const { service } = setup({ target: null });

    const result = await service.forward(READ);

    expect(result.status).toBe(404);
  });

  /*
   * OrangeHRM signs in as its administrator, so the username comes from `instance_env_value`. That
   * lookup selected `name` and `value` — neither is a column; the table stores `var_name` and
   * `value_enc` — so every call to this product died with `42703` and reached the run panel as a bare
   * `502 PRODUCT_CREDENTIAL_UNAVAILABLE` with no operator-facing explanation.
   */
  it('reads the administrator name from the instance variables the schema actually has', async () => {
    const { service, pool } = setup();

    const result = await service.forward(READ);

    expect(result.status).toBe(502);
    expect(result.body?.toString()).toContain('no ORANGEHRM_ADMIN_USERNAME variable');
    const lookup = pool.query.mock.calls
      .map((call) => String(call[0]))
      .find((sql) => sql.includes('instance_env_value'));
    expect(lookup).toContain('var_name');
    expect(lookup).toContain('value_enc');
  });
});
