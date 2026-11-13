import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { BrokerEgressService } from '../../../../src/modules/m25-workflow-egress/egress.service';
import type {
  EgressRequest,
  FieldDiscoveryRequest,
} from '../../../../src/modules/m25-workflow-egress/egress.contract';

/**
 * AD-10 / FR-5.5 — the hop that actually leaves the process.
 *
 * `egress.service.test.ts` pins the refusals, which are all answered from the token and the catalog.
 * This file covers the other half: the product call itself, the credential the platform adds to it,
 * and the authoring-time schema read. Both are places where a mistake is silent — a relayed hop
 * header, a cookie sent back with its attributes, or a schema invented from a shape the adapter did
 * not understand.
 */
const { productFetchMock, signInMock } = vi.hoisted(() => ({
  productFetchMock: vi.fn(),
  signInMock: vi.fn(),
}));

vi.mock('../../../../src/modules/m24-sign-in-relay/product-http', () => ({
  productFetch: productFetchMock,
}));

vi.mock('../../../../src/modules/m24-sign-in-relay/adapters/orangehrm-login', () => ({
  orangeHrmLogin: { name: 'orangehrm', signIn: signInMock, verify: vi.fn() },
}));

const SESSION_TARGET = {
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
  ],
};

const ESPO_TARGET = {
  instance_id: 'inst-1',
  entry_key: 'D01-01',
  slug: 'espocrm',
  payload: { httpPort: 80 },
  host: 'espocrm.localhost',
  operations: [{ id: 'contacts.write', mode: 'write', path: '/api/v1/Contact', method: 'POST' }],
};

const OPENPROJECT_TARGET = {
  instance_id: 'inst-1',
  entry_key: 'D09-01',
  slug: 'openproject',
  payload: { httpPort: 80 },
  host: 'openproject.localhost',
  operations: [
    {
      id: 'work_packages.write',
      mode: 'write',
      path: '/api/v3/work_packages',
      method: 'POST',
    },
  ],
};

const UNKNOWN_TARGET = {
  instance_id: 'inst-1',
  entry_key: 'D02-01',
  slug: 'plain',
  payload: { httpPort: 80 },
  host: 'plain.localhost',
  operations: [{ id: 'things.write', mode: 'write', path: '/things', method: 'POST' }],
};

type Setup = {
  target?: Record<string, unknown> | null;
  /** The value of `ORANGEHRM_ADMIN_USERNAME` on the instance, or `null` when it was never set. */
  variable?: string | null;
  /** What the secret store answers; `null` is an instance that never got the credential. */
  secret?: string | null;
  /** The relay login driver's verdict. */
  signIn?: Record<string, unknown>;
};

function setup(options: Setup = {}) {
  const variable = options.variable ?? null;
  const secret = options.secret ?? null;
  const scope = {
    scopeId: 'scope-1',
    instanceId: 'inst-1',
    workflowId: 'wf-1',
    versionId: 'v1',
    operations: ['employees.read', 'contacts.write', 'work_packages.write', 'things.write'],
    mode: 'write' as const,
    expiresAt: '2030-01-01T00:00:00.000Z',
  };
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM instance i')) {
        const row = options.target === undefined ? SESSION_TARGET : options.target;
        return { rows: row === null ? [] : [row] };
      }
      if (sql.includes('instance_env_value')) {
        return {
          rows: variable === null ? [] : [{ value_enc: Buffer.from(variable, 'utf8') }],
        };
      }
      return { rows: [] };
    }),
  };
  const audit = { append: vi.fn(async () => undefined) };
  const secrets = {
    find: vi.fn(async () => (secret === null ? null : { id: 'secret-1' })),
    open: vi.fn(async () => secret ?? ''),
  };
  signInMock.mockResolvedValue(
    options.signIn ?? { ok: true, cookies: ['orangehrm_session=abc; Path=/; HttpOnly'] },
  );
  const docker = {
    networkEndpoints: vi.fn(async () => []),
    connectNetwork: vi.fn(async () => undefined),
  };
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
    secrets as never,
    { verifyToken: vi.fn(async () => scope) } as never,
    docker as never,
  );
  return { service, pool, audit, secrets, docker };
}

function read(over: Partial<EgressRequest> = {}): EgressRequest {
  return {
    token: 'seamnex_token',
    entryKey: 'D07-01',
    operation: 'employees.read',
    method: 'GET',
    query: '',
    contentType: null,
    accept: null,
    body: null,
    ...over,
  };
}

function dispatch(over: Partial<FieldDiscoveryRequest> = {}): FieldDiscoveryRequest {
  return { instanceId: 'inst-1', entryKey: 'D01-01', operation: 'contacts.write', ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  signInMock.mockReset();
  productFetchMock.mockReset();
});

describe('brokered call to a product', () => {
  it('adds the administrator session and relays the product answer', async () => {
    const { service, audit, secrets } = setup({ variable: 'admin', secret: 'seed-pass' });
    productFetchMock.mockResolvedValue(
      new Response('{"data":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await service.forward(read({ accept: 'application/json' }));

    expect(productFetchMock).toHaveBeenCalledOnce();
    const [url, init] = productFetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://orangehrm:80/web/index.php/api/v2/pim/employees');
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: {
        // The public name, port included: the product builds its own answers from what it was called.
        host: 'orangehrm.localhost:8020',
        accept: 'application/json',
        // The driver emits the product's full `Set-Cookie`; a request carries `name=value` only.
        cookie: 'orangehrm_session=abc',
      },
    });
    expect(init.body).toBeUndefined();

    expect(result.status).toBe(200);
    expect(result.body?.toString('utf8')).toBe('{"data":[]}');
    expect(result.headers['content-type']).toBe('application/json');
    // The credential was read, used and not retained in the result.
    expect(secrets.open).toHaveBeenCalledWith('secret-1', 'workflow egress to inst-1', {
      scope: 'instance',
      ownerId: 'inst-1',
    });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.egress',
        outcome: 'success',
        detail: expect.objectContaining({ operation: 'employees.read', status: 200 }),
      }),
    );
  });

  it('does not relay a hop header back to the caller', async () => {
    const { service } = setup({ variable: 'admin', secret: 'seed-pass' });
    productFetchMock.mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'product=1; Path=/',
          'x-product': 'kept',
        },
      }),
    );

    const result = await service.forward(read());

    expect(result.headers).toEqual({ 'content-type': 'application/json', 'x-product': 'kept' });
  });

  it('answers a bodyless product response with no body of its own', async () => {
    const { service } = setup({ variable: 'admin', secret: 'seed-pass' });
    productFetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const result = await service.forward(read());

    expect(result.status).toBe(200);
    expect(result.body).toBeNull();
  });

  it('forwards a body and a content type when the node sends one', async () => {
    const { service } = setup({ variable: 'admin', secret: 'seed-pass' });
    productFetchMock.mockResolvedValue(new Response('{"id":"1"}', { status: 201 }));
    const body = Buffer.from('{"a":1}', 'utf8');

    await service.forward(
      read({ method: 'GET', contentType: 'application/json', body, query: '?page=2' }),
    );

    const [url, init] = productFetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://orangehrm:80/web/index.php/api/v2/pim/employees?page=2');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe(body);
  });

  it('uses Basic authentication for a product that has no API key', async () => {
    const { service } = setup({ target: ESPO_TARGET, secret: 'espo-secret' });
    productFetchMock.mockResolvedValue(new Response('{"id":"1"}', { status: 201 }));

    await service.forward(
      read({
        entryKey: 'D01-01',
        operation: 'contacts.write',
        method: 'POST',
        contentType: 'application/json',
        body: Buffer.from('{}', 'utf8'),
      }),
    );

    const [, init] = productFetchMock.mock.calls[0] ?? [];
    const expected = Buffer.from('admin:espo-secret', 'utf8').toString('base64');
    expect(init.headers.authorization).toBe(`Basic ${expected}`);
  });

  it('uses a bearer token for a product that mints one', async () => {
    const { service } = setup({ target: OPENPROJECT_TARGET, secret: 'opapi-1' });
    productFetchMock.mockResolvedValue(new Response('{}', { status: 201 }));

    await service.forward(
      read({ entryKey: 'D09-01', operation: 'work_packages.write', method: 'POST' }),
    );

    const [, init] = productFetchMock.mock.calls[0] ?? [];
    expect(init.headers.authorization).toBe('Bearer opapi-1');
  });

  it('reuses one administrator session across calls to the same product', async () => {
    const { service } = setup({ variable: 'admin', secret: 'seed-pass' });
    productFetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));

    await service.forward(read());
    await service.forward(read());

    expect(signInMock).toHaveBeenCalledOnce();
  });

  it('refuses a product that declares no way for the platform to authenticate', async () => {
    const { service } = setup({ target: UNKNOWN_TARGET });

    const result = await service.forward(
      read({ entryKey: 'D02-01', operation: 'things.write', method: 'POST' }),
    );

    expect(result.status).toBe(502);
    expect(result.body?.toString()).toContain('declares no egress credential');
    expect(productFetchMock).not.toHaveBeenCalled();
  });

  it('refuses a call when the instance holds no credential for the product', async () => {
    const { service } = setup({ target: OPENPROJECT_TARGET, secret: null });

    const result = await service.forward(
      read({ entryKey: 'D09-01', operation: 'work_packages.write', method: 'POST' }),
    );

    expect(result.status).toBe(502);
    expect(result.body?.toString()).toContain('no product_api_token secret');
  });

  it('reports a refused administrator sign-in as a credential problem', async () => {
    const { service } = setup({
      variable: 'admin',
      secret: 'seed-pass',
      signIn: { ok: false, reason: 'credential_rejected', detail: 'the product refused it' },
    });

    const result = await service.forward(read());

    expect(result.status).toBe(502);
    expect(result.body?.toString()).toContain('refused the platform');
    expect(productFetchMock).not.toHaveBeenCalled();
  });

  it('reports a product that cannot be reached as unreachable, not as a bug', async () => {
    const { service, audit } = setup({ variable: 'admin', secret: 'seed-pass' });
    productFetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await service.forward(read());

    expect(result.status).toBe(502);
    expect(result.body?.toString()).toContain('could not be called');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        detail: expect.objectContaining({ code: 'PRODUCT_UNREACHABLE' }),
      }),
    );
  });

  it('records a product refusal as a failure without failing the call', async () => {
    const { service, audit } = setup({ variable: 'admin', secret: 'seed-pass' });
    productFetchMock.mockResolvedValue(
      new Response('{"error":"nope"}', { status: 500, headers: { 'content-type': 'text/plain' } }),
    );

    const result = await service.forward(read());

    expect(result.status).toBe(500);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        detail: expect.objectContaining({ code: 'PRODUCT_REJECTED' }),
      }),
    );
  });

  it('answers the caller even when the audit chain refuses the row', async () => {
    const { service, audit } = setup({ variable: 'admin', secret: 'seed-pass' });
    audit.append.mockRejectedValue(new Error('audit unavailable'));
    productFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const result = await service.forward(read());

    expect(result.status).toBe(200);
    expect(audit.append).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be audited'));
    warn.mockRestore();
  });

  it('refuses a verb that disagrees with the catalog before dialling the product', async () => {
    const { service } = setup({ variable: 'admin', secret: 'seed-pass' });

    const result = await service.forward(read({ method: 'DELETE' }));

    expect(result.status).toBe(405);
    expect(productFetchMock).not.toHaveBeenCalled();
  });
});

describe('field discovery through the product credential', () => {
  it('reads the fields an operation accepts from the product metadata', async () => {
    const { service } = setup({ target: ESPO_TARGET, secret: 'espo-secret' });
    productFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          entityDefs: {
            Contact: {
              fields: { emailAddress: { type: 'email', required: true, label: 'Email' } },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await service.discoverFields(dispatch());

    expect(result).toEqual({
      status: 'available',
      fields: [{ name: 'emailAddress', label: 'Email', type: 'string', required: true }],
    });
    const [url, init] = productFetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://espocrm:80/api/v1/Metadata');
    expect(init).toMatchObject({ method: 'GET', headers: { host: 'espocrm.localhost:8020' } });
  });

  it('answers unsupported for a product that has no field-schema adapter', async () => {
    const { service } = setup({ target: UNKNOWN_TARGET, secret: 'espo-secret' });

    const result = await service.discoverFields(
      dispatch({ entryKey: 'D02-01', operation: 'things.write' }),
    );

    expect(result).toEqual({
      status: 'unsupported',
      detail: expect.stringContaining('has no field-schema adapter'),
    });
    expect(productFetchMock).not.toHaveBeenCalled();
  });

  it('answers unavailable when the product is not deployed', async () => {
    const { service } = setup({ target: null });

    const result = await service.discoverFields(dispatch());

    expect(result).toEqual({
      status: 'unavailable',
      detail: 'The product is not deployed, so its field list cannot be read.',
    });
  });

  it('answers unavailable when the deployed product is not the catalog entry named', async () => {
    const { service } = setup();

    const result = await service.discoverFields(dispatch({ entryKey: 'D09-01' }));

    expect(result).toEqual({
      status: 'unavailable',
      detail: 'The deployed product no longer matches the catalog entry this node names.',
    });
  });

  it('answers unsupported when the adapter does not cover the operation', async () => {
    const { service } = setup({ target: OPENPROJECT_TARGET, secret: 'opapi-1' });

    const result = await service.discoverFields(
      dispatch({ entryKey: 'D09-01', operation: 'projects.read' }),
    );

    expect(result).toEqual({
      status: 'unsupported',
      detail: expect.stringContaining('not a work package'),
    });
    expect(productFetchMock).not.toHaveBeenCalled();
  });

  it('answers unavailable when the platform cannot authenticate', async () => {
    const { service } = setup({ target: ESPO_TARGET, secret: null });

    const result = await service.discoverFields(dispatch());

    expect(result.status).toBe('unavailable');
    expect(result).toEqual({
      status: 'unavailable',
      detail: expect.stringContaining('could not authenticate to D01-01'),
    });
  });

  it('answers unavailable when the product cannot be reached', async () => {
    const { service } = setup({ target: ESPO_TARGET, secret: 'espo-secret' });
    productFetchMock.mockRejectedValue(new Error('socket hang up'));

    const result = await service.discoverFields(dispatch());

    expect(result).toEqual({
      status: 'unavailable',
      detail: expect.stringContaining('could not be reached to read its fields'),
    });
  });

  it('answers unavailable with the status only when the product refuses', async () => {
    const { service } = setup({ target: ESPO_TARGET, secret: 'espo-secret' });
    productFetchMock.mockResolvedValue(
      new Response('<html>internal error</html>', { status: 503 }),
    );

    const result = await service.discoverFields(dispatch());

    expect(result).toEqual({
      status: 'unavailable',
      detail: 'D01-01 answered 503 when asked for its field schema.',
    });
    // The product's body is HTML and may echo account data; it never reaches the answer.
    expect(JSON.stringify(result)).not.toContain('internal error');
  });

  it('answers unavailable when the product answers with something that is not JSON', async () => {
    const { service } = setup({ target: ESPO_TARGET, secret: 'espo-secret' });
    productFetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

    const result = await service.discoverFields(dispatch());

    expect(result).toEqual({
      status: 'unavailable',
      detail: 'D01-01 answered with a body that is not JSON.',
    });
  });

  it('answers unsupported when the payload carries no field of the expected shape', async () => {
    const { service } = setup({ target: ESPO_TARGET, secret: 'espo-secret' });
    productFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ entityDefs: { Contact: { fields: {} } } }), { status: 200 }),
    );

    const result = await service.discoverFields(dispatch());

    expect(result).toEqual({
      status: 'unsupported',
      detail: expect.stringContaining('does not name a collection'),
    });
  });

  it('answers unavailable when the payload cannot be enumerated at all', async () => {
    const { service } = setup({ target: OPENPROJECT_TARGET, secret: 'opapi-1' });
    // A payload whose nested "schema" answers every key with itself and refuses enumeration: the
    // adapter throws rather than inventing a field list, and the drawer gets an ordinary answer.
    const hostile: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
      get: () => hostile,
      ownKeys: () => {
        throw new Error('the body is not a plain object');
      },
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: hostile }),
    });
    productFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => hostile,
    } as unknown as Response);

    const result = await service.discoverFields(
      dispatch({ entryKey: 'D09-01', operation: 'work_packages.write' }),
    );

    expect(result).toEqual({
      status: 'unavailable',
      detail: expect.stringContaining('could not be read'),
    });
  });
});
