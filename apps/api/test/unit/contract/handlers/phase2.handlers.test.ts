import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Phase2Handlers } from '../../../../src/contract/handlers/phase2.handlers';
import type { OperationHandler } from '../../../../src/contract/operation-handler';
import { AppError } from '../../../../src/common/problem/app-error';
import { callHandler, operationInput } from '../../../support/operation-input';

/**
 * Handlers are orchestration, so each case asserts the delegation it performs and the result shape
 * the dispatcher will write. The services are plain doubles: no module graph, no database.
 */
function services() {
  return {
    catalog: {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      reload: vi.fn().mockResolvedValue({ inserted: 1, updated: 0, removed: 0 }),
      entry: vi.fn().mockResolvedValue({ key: 'D01-01' }),
      patchIntegrationMetadata: vi.fn().mockResolvedValue({ key: 'D01-01' }),
    },
    env: {
      applySchemas: vi.fn().mockResolvedValue({ applied: 1, refused: [] }),
      schema: vi.fn().mockResolvedValue({ vars: [] }),
      plan: vi.fn().mockResolvedValue({ diff: [] }),
      importEnv: vi.fn().mockResolvedValue({ imported: 2 }),
      profiles: vi.fn().mockResolvedValue([]),
      instanceEnv: vi.fn().mockResolvedValue({ values: {} }),
      updateInstanceEnv: vi.fn().mockResolvedValue({ diff: [] }),
    },
    executor: {
      instances: vi.fn().mockResolvedValue([]),
      instance: vi.fn().mockResolvedValue({ id: 'i1' }),
      drift: vi.fn().mockResolvedValue({ drifted: false }),
      images: vi.fn().mockResolvedValue([]),
      plan: vi.fn().mockResolvedValue({ steps: [] }),
      lifecycle: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
    },
    status: {
      status: vi.fn().mockResolvedValue({ state: 'ready' }),
      containers: vi.fn().mockResolvedValue([]),
    },
    integration: { checks: vi.fn().mockResolvedValue([]) },
    identity: {
      users: vi.fn().mockResolvedValue({ items: [] }),
      user: vi.fn().mockResolvedValue({ id: 'u1' }),
      userEntitlements: vi.fn().mockResolvedValue([]),
      groups: vi.fn().mockResolvedValue([]),
      mapGroup: vi.fn().mockResolvedValue({ id: 'g1' }),
      syncRuns: vi.fn().mockResolvedValue([]),
      accessRequests: vi.fn().mockResolvedValue([]),
      createAccessRequest: vi.fn().mockResolvedValue({ id: 'ar1' }),
    },
    access: {
      settings: vi.fn().mockResolvedValue({ settings: { a: 1 }, etag: '"v1"' }),
      putSettings: vi.fn().mockResolvedValue({ settings: { a: 2 }, etag: '"v2"' }),
    },
    portal: {
      me: vi.fn().mockResolvedValue({ id: 'me' }),
      entitlements: vi.fn().mockResolvedValue([]),
      launcher: vi.fn().mockResolvedValue([]),
      statusBanner: vi.fn().mockResolvedValue(null),
      launchTarget: vi.fn().mockResolvedValue({}),
      launchTicket: vi.fn().mockResolvedValue({ ticket: 't' }),
      recordLaunch: vi.fn().mockResolvedValue({}),
      product: vi.fn().mockResolvedValue({ slug: 'p' }),
      requestable: vi.fn().mockResolvedValue([]),
    },
    registry: {
      entries: vi.fn().mockResolvedValue([]),
      entry: vi.fn().mockResolvedValue({ slug: 's' }),
      stale: vi.fn().mockResolvedValue([]),
    },
    workflows: {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      get: vi.fn().mockResolvedValue({ id: 'w1' }),
      rename: vi.fn().mockResolvedValue({ workflow: { id: 'w1' }, etag: '"w1"' }),
      remove: vi.fn().mockResolvedValue(undefined),
      runs: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue({ id: 'r1' }),
      export: vi.fn().mockResolvedValue({ document: {} }),
    },
    governance: {
      maintenance: vi.fn().mockResolvedValue([]),
      policyExceptions: vi.fn().mockResolvedValue([]),
      dsar: vi.fn().mockResolvedValue([]),
      licenses: vi.fn().mockResolvedValue([]),
      setHostedService: vi.fn().mockResolvedValue({ enabled: true }),
      patches: vi.fn().mockResolvedValue([]),
      posture: vi.fn().mockResolvedValue({}),
      breakGlass: vi.fn().mockResolvedValue([]),
    },
    capacity: {
      snapshot: vi.fn().mockResolvedValue({}),
      forecast: vi.fn().mockResolvedValue({}),
    },
    params: {
      write: vi.fn().mockResolvedValue(undefined),
      assertWritable: vi.fn(),
    },
    repository: {
      load: vi.fn().mockResolvedValue({ entries: [], envSchemas: [], revision: 'r1', invalid: [] }),
    },
    // The relay's provisioning credential. Write-only by contract: both calls answer metadata.
    adminCredential: {
      status: vi.fn().mockResolvedValue({
        kind: 'bearer',
        required: true,
        configured: false,
        name: 'product_api_token',
        version: null,
      }),
      store: vi.fn().mockResolvedValue({
        kind: 'bearer',
        required: true,
        configured: true,
        name: 'product_api_token',
        version: 1,
      }),
    },
    // ADR-BE-22: the on-demand pass answers in counts, not in reassurance.
    accounts: {
      sweep: vi.fn().mockResolvedValue(undefined),
      provisionInstance: vi.fn().mockResolvedValue({
        instanceId: 'i-1',
        enabled: true,
        configured: true,
        considered: 2,
        provisioned: 1,
        failed: 1,
      }),
      deprovision: vi.fn().mockResolvedValue(undefined),
    },
  };
}

let s: ReturnType<typeof services>;
let handlers: ReadonlyMap<string, OperationHandler>;

beforeEach(() => {
  s = services();
  handlers = new Phase2Handlers(
    s.catalog as never,
    s.env as never,
    s.executor as never,
    s.status as never,
    s.integration as never,
    s.identity as never,
    s.access as never,
    s.portal as never,
    s.registry as never,
    s.workflows as never,
    s.governance as never,
    s.capacity as never,
    s.params as never,
    s.repository as never,
    s.adminCredential as never,
    s.accounts as never,
  ).handlers();
});

const call = (key: string, overrides = {}) =>
  callHandler(handlers, key, operationInput(key, overrides));

describe('portal handlers', () => {
  it('GET /me passes the identity and session facts', async () => {
    const result = await call('GET /me');
    expect(s.portal.me).toHaveBeenCalledWith(
      'sub-1',
      expect.objectContaining({ roles: ['platform-admin'] }),
    );
    expect(result).toEqual({ kind: 'body', body: { id: 'me' } });
  });

  it('GET /me defaults an absent session expiry to now', async () => {
    await call('GET /me', {
      context: { ...operationInput('GET /me').context, sessionExpiresAt: null },
    });
    const [, facts] = s.portal.me.mock.calls[0] as [string, { sessionExpiresAt: string }];
    expect(Number.isNaN(Date.parse(facts.sessionExpiresAt))).toBe(false);
  });

  it('delegates every remaining portal read and write', async () => {
    await call('GET /me/entitlements');
    await call('GET /me/launcher');
    await call('GET /portal/status-banner');
    await call('GET /portal/launch-targets/:instanceId', { params: { instanceId: 'i1' } });
    await call('POST /portal/launch-tickets/:instanceId', { params: { instanceId: 'i1' } });
    await call('POST /portal/launch-events/:instanceId', { params: { instanceId: 'i1' } });
    await call('GET /portal/products/:slug', { params: { slug: 'p' } });
    await call('GET /portal/requestable');

    expect(s.portal.entitlements).toHaveBeenCalledWith('sub-1');
    expect(s.portal.launcher).toHaveBeenCalledWith('sub-1');
    expect(s.portal.statusBanner).toHaveBeenCalledOnce();
    expect(s.portal.launchTarget).toHaveBeenCalledWith('sub-1', 'i1');
    expect(s.portal.launchTicket).toHaveBeenCalledWith('sub-1', 'i1', 'sess-1');
    expect(s.portal.recordLaunch).toHaveBeenCalledWith('sub-1', 'i1');
    expect(s.portal.product).toHaveBeenCalledWith('sub-1', 'p');
    expect(s.portal.requestable).toHaveBeenCalledWith('sub-1');
  });

  it('refuses a portal route with a missing path parameter', async () => {
    await expect(call('GET /portal/launch-targets/:instanceId')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
    });
  });
});

describe('catalog handlers', () => {
  it('GET /catalog forwards only the filters that are present', async () => {
    await call('GET /catalog');
    expect(s.catalog.list).toHaveBeenCalledWith({});

    await call('GET /catalog', { query: { q: 'mail', cluster: 'c1', packaging: 'compose' } });
    expect(s.catalog.list).toHaveBeenLastCalledWith({
      q: 'mail',
      cluster: 'c1',
      packaging: 'compose',
    });
  });

  it('POST /catalog/reload projects entries and environment in one pass', async () => {
    const result = await call('POST /catalog/reload');
    expect(s.repository.load).toHaveBeenCalledOnce();
    expect(s.catalog.reload).toHaveBeenCalledWith({ actorId: 'sub-1', tree: expect.anything() });
    expect(s.env.applySchemas).toHaveBeenCalledWith({
      schemas: [],
      revision: 'r1',
      actorId: 'sub-1',
    });
    expect(result).toEqual({
      kind: 'body',
      body: {
        inserted: 1,
        updated: 0,
        removed: 0,
        environment: { applied: 1, refused: [] },
        invalid: [],
      },
    });
  });

  it('GET /catalog/:key and its env surfaces pass the key through', async () => {
    await call('GET /catalog/:key', { params: { key: 'D01-01' } });
    await call('GET /catalog/:key/env-schema', { params: { key: 'D01-01' } });
    await call('GET /catalog/:key/env-plan', { params: { key: 'D01-01' } });
    await call('POST /catalog/:key/env-import', {
      params: { key: 'D01-01' },
      body: { source: 'dotenv', content: 'A=1' },
    });
    await call('GET /env-profiles');
    await call('PATCH /catalog/:key/integration-metadata', {
      params: { key: 'D01-01' },
      body: { credentialGranularity: 'shared' },
    });

    expect(s.catalog.entry).toHaveBeenCalledWith('D01-01');
    expect(s.env.schema).toHaveBeenCalledWith('D01-01');
    expect(s.env.plan).toHaveBeenCalledWith({ entryKey: 'D01-01', overrides: {} });
    expect(s.env.importEnv).toHaveBeenCalledWith(
      { entryKey: 'D01-01', source: 'dotenv', content: 'A=1' },
      'sub-1',
    );
    expect(s.env.profiles).toHaveBeenCalledOnce();
    expect(s.catalog.patchIntegrationMetadata).toHaveBeenCalledWith(
      'D01-01',
      { credentialGranularity: 'shared' },
      'sub-1',
    );
  });

  it('GET /catalog/:key/env-plan forwards a profile and the declared env family', async () => {
    await call('GET /catalog/:key/env-plan', {
      params: { key: 'D01-01' },
      query: { profile: 'prod' },
      families: { env: { MAIL_HOST: 'smtp' } },
    });
    expect(s.env.plan).toHaveBeenCalledWith({
      entryKey: 'D01-01',
      profileKey: 'prod',
      overrides: { MAIL_HOST: 'smtp' },
    });
  });
});

describe('instance handlers', () => {
  it('GET /instances forwards present filters only', async () => {
    await call('GET /instances');
    expect(s.executor.instances).toHaveBeenCalledWith({});
    await call('GET /instances', { query: { q: 'x', state: 'ready', entryKey: 'D01-01' } });
    expect(s.executor.instances).toHaveBeenLastCalledWith({
      q: 'x',
      state: 'ready',
      entryKey: 'D01-01',
    });
  });

  it('GET /instances/:id combines the instance with its integration checks', async () => {
    const result = await call('GET /instances/:id', { params: { id: 'i1' } });
    expect(result).toEqual({ kind: 'body', body: { id: 'i1', integrationChecks: [] } });
  });

  it('GET /instances/:id/status only refreshes when the query says true', async () => {
    await call('GET /instances/:id/status', { params: { id: 'i1' } });
    expect(s.status.status).toHaveBeenCalledWith('i1', false);
    await call('GET /instances/:id/status', { params: { id: 'i1' }, query: { refresh: 'true' } });
    expect(s.status.status).toHaveBeenLastCalledWith('i1', true);
  });

  it('delegates the remaining instance reads', async () => {
    await call('GET /instances/:id/containers', { params: { id: 'i1' } });
    await call('GET /instances/:id/env', { params: { id: 'i1' } });
    await call('GET /instances/:id/drift', { params: { id: 'i1' } });
    await call('GET /instances/:id/images', { params: { id: 'i1' } });
    await call('GET /instances/:id/plan', { params: { id: 'i1' } });

    expect(s.status.containers).toHaveBeenCalledWith('i1');
    expect(s.env.instanceEnv).toHaveBeenCalledWith('i1');
    expect(s.executor.drift).toHaveBeenCalledWith('i1');
    expect(s.executor.images).toHaveBeenCalledWith('i1');
    expect(s.executor.plan).toHaveBeenCalledWith('i1', 'upgrade');
  });

  it('GET /instances/:id/plan honours an explicit action', async () => {
    await call('GET /instances/:id/plan', { params: { id: 'i1' }, query: { action: 'delete' } });
    expect(s.executor.plan).toHaveBeenCalledWith('i1', 'delete');
  });
});

describe('PUT /instances/:id/env', () => {
  const body = { values: { MAIL_HOST: 'smtp' } };

  it('stores a change and queues the reconfigure job', async () => {
    s.env.updateInstanceEnv.mockResolvedValue({ diff: [{ name: 'MAIL_HOST' }] });

    const result = await call('PUT /instances/:id/env', { params: { id: 'i1' }, body });

    expect(s.params.write).toHaveBeenCalledWith('i1', 'sub-1');
    expect(s.executor.lifecycle).toHaveBeenCalledWith({
      instanceId: 'i1',
      action: 'reconfigure',
      actorId: 'sub-1',
    });
    expect(result).toMatchObject({ kind: 'body', body: { applied: true } });
  });

  it('returns early when nothing changed, without a job or a rewrite', async () => {
    s.env.updateInstanceEnv.mockResolvedValue({ diff: [] });

    const result = await call('PUT /instances/:id/env', { params: { id: 'i1' }, body });

    expect(s.params.write).not.toHaveBeenCalled();
    expect(s.executor.lifecycle).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'body', body: { diff: [] } });
  });

  it('refuses with REPOSITORY_UNAVAILABLE when the definition cannot be committed', async () => {
    s.env.updateInstanceEnv.mockResolvedValue({ diff: [{ name: 'MAIL_HOST' }] });
    s.params.write.mockRejectedValue(new Error('read-only mount'));

    await expect(
      call('PUT /instances/:id/env', { params: { id: 'i1' }, body }),
    ).rejects.toMatchObject({
      code: 'REPOSITORY_UNAVAILABLE',
      detail: expect.stringContaining('read-only mount'),
    });
  });

  it('reports a stored change whose reconfigure job could not be queued', async () => {
    s.env.updateInstanceEnv.mockResolvedValue({ diff: [{ name: 'MAIL_HOST' }] });
    s.executor.lifecycle.mockRejectedValue(new Error('instance busy'));

    const result = await call('PUT /instances/:id/env', { params: { id: 'i1' }, body });

    expect(result).toMatchObject({
      kind: 'body',
      body: { applied: false, note: expect.stringContaining('instance busy') },
    });
  });

  it('stringifies a non-Error lifecycle failure', async () => {
    s.env.updateInstanceEnv.mockResolvedValue({ diff: [{ name: 'X' }] });
    s.executor.lifecycle.mockRejectedValue('plain');

    const result = await call('PUT /instances/:id/env', { params: { id: 'i1' }, body });
    expect(result).toMatchObject({ kind: 'body', body: { applied: false } });
  });

  it('stringifies a non-Error repository failure', async () => {
    s.env.updateInstanceEnv.mockResolvedValue({ diff: [{ name: 'X' }] });
    s.params.write.mockRejectedValue('nope');

    await expect(
      call('PUT /instances/:id/env', { params: { id: 'i1' }, body }),
    ).rejects.toMatchObject({
      code: 'REPOSITORY_UNAVAILABLE',
      detail: expect.stringContaining('nope'),
    });
  });
});

describe('admin handlers', () => {
  it('delegates the identity directory reads', async () => {
    await call('GET /admin/users', { query: { q: 'a', after: 'b' } });
    await call('GET /admin/users/:id', { params: { id: 'u1' } });
    await call('GET /admin/users/:id/entitlements', { params: { id: 'u1' } });
    await call('GET /admin/groups');
    await call('GET /admin/identity-sync');

    expect(s.identity.users).toHaveBeenCalledWith('a', 'b');
    expect(s.identity.user).toHaveBeenCalledWith('u1');
    expect(s.identity.userEntitlements).toHaveBeenCalledWith('u1');
    expect(s.identity.groups).toHaveBeenCalledOnce();
    expect(s.identity.syncRuns).toHaveBeenCalledOnce();
  });

  it('PUT /admin/groups/:id/mapping sends the role, scope and propagation flag', async () => {
    const body = { role: 'operator', scopeType: 'domain', scopeLabel: 'Core', propagate: true };
    await call('PUT /admin/groups/:id/mapping', { params: { id: 'g1' }, body });
    expect(s.identity.mapGroup).toHaveBeenCalledWith('g1', body, 'sub-1');
  });

  it('GET /admin/settings answers with the validator it read', async () => {
    const result = await call('GET /admin/settings');
    expect(result).toEqual({ kind: 'body', body: { a: 1 }, etag: '"v1"' });
  });

  it('PUT /admin/settings forwards If-Match, including a repeated header', async () => {
    await call('PUT /admin/settings', { body: { a: 2 }, headers: { 'if-match': '"v1"' } });
    expect(s.access.putSettings).toHaveBeenCalledWith({ a: 2 }, '"v1"', 'sub-1');

    await call('PUT /admin/settings', {
      body: { a: 2 },
      headers: { 'if-match': ['"v1"', '"v2"'] },
    });
    expect(s.access.putSettings).toHaveBeenLastCalledWith({ a: 2 }, '"v1"', 'sub-1');
  });

  it('delegates the access-request reads and writes', async () => {
    await call('GET /admin/access-requests');
    await call('POST /admin/access-requests', {
      body: { entryKey: 'D01-01', justification: 'need' },
    });
    expect(s.identity.accessRequests).toHaveBeenCalledOnce();
    expect(s.identity.createAccessRequest).toHaveBeenCalledWith(
      { entryKey: 'D01-01', justification: 'need' },
      'sub-1',
    );
  });

  it('delegates the governance read surfaces', async () => {
    await call('GET /admin/maintenance-windows');
    await call('GET /admin/policy-exceptions');
    await call('GET /admin/dsar');
    await call('GET /licenses');
    await call('GET /patch-register');
    await call('GET /posture');
    await call('GET /break-glass-sessions');

    expect(s.governance.maintenance).toHaveBeenCalledOnce();
    expect(s.governance.policyExceptions).toHaveBeenCalledOnce();
    expect(s.governance.dsar).toHaveBeenCalledOnce();
    expect(s.governance.licenses).toHaveBeenCalledOnce();
    expect(s.governance.patches).toHaveBeenCalledOnce();
    expect(s.governance.posture).toHaveBeenCalledOnce();
    expect(s.governance.breakGlass).toHaveBeenCalledOnce();
  });

  it('PUT /licenses/:instanceId/hosted-service forwards the toggle', async () => {
    await call('PUT /licenses/:instanceId/hosted-service', {
      params: { instanceId: 'i1' },
      body: { enabled: true },
    });
    expect(s.governance.setHostedService).toHaveBeenCalledWith('i1', true, 'sub-1');
  });
});

describe('capacity and registry handlers', () => {
  it('delegates the capacity reads', async () => {
    await call('GET /capacity');
    await call('GET /capacity/forecast');
    expect(s.capacity.snapshot).toHaveBeenCalledOnce();
    expect(s.capacity.forecast).toHaveBeenCalledOnce();
  });

  it('delegates the registry reads', async () => {
    await call('GET /registry/instances');
    await call('GET /registry/instances/:slug', { params: { slug: 'mail' } });
    await call('GET /registry/stale');
    expect(s.registry.entries).toHaveBeenCalledOnce();
    expect(s.registry.entry).toHaveBeenCalledWith('mail');
    expect(s.registry.stale).toHaveBeenCalledOnce();
  });
});

describe('workflow handlers', () => {
  it('GET /workflows reports the match count in x-total-count', async () => {
    s.workflows.list.mockResolvedValue({ items: [{ id: 'w1' }], total: 7 });

    const result = await call('GET /workflows');

    expect(result).toEqual({
      kind: 'body',
      body: [{ id: 'w1' }],
      headers: { 'x-total-count': '7' },
    });
  });

  it('GET /workflows omits absent filters and coerces present ones', async () => {
    await call('GET /workflows');
    expect(s.workflows.list).toHaveBeenCalledWith({});

    await call('GET /workflows', {
      query: { state: 'draft', q: 'mail', limit: '10', offset: '20' },
    });
    expect(s.workflows.list).toHaveBeenLastCalledWith({
      state: 'draft',
      q: 'mail',
      limit: 10,
      offset: 20,
    });
  });

  it('refuses a declared integer that does not parse', async () => {
    await expect(call('GET /workflows', { query: { limit: 'ten' } })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [{ field: 'limit', code: 'invalid_type', message: expect.any(String) }],
    });
  });

  it('GET /workflows/:id delegates the read', async () => {
    expect(await call('GET /workflows/:id', { params: { id: 'w1' } })).toEqual({
      kind: 'body',
      body: { id: 'w1' },
    });
  });

  it('PATCH /workflows/:id forwards If-Match and returns the new validator', async () => {
    const result = await call('PATCH /workflows/:id', {
      params: { id: 'w1' },
      body: { name: 'renamed' },
      headers: { 'if-match': '"old"' },
    });

    expect(s.workflows.rename).toHaveBeenCalledWith('w1', { name: 'renamed' }, '"old"', 'sub-1');
    expect(result).toEqual({ kind: 'body', body: { id: 'w1' }, etag: '"w1"' });
  });

  it('DELETE /workflows/:id is a 204', async () => {
    const result = await call('DELETE /workflows/:id', { params: { id: 'w1' } });
    expect(s.workflows.remove).toHaveBeenCalledWith('w1', 'sub-1');
    expect(result).toEqual({ kind: 'noContent' });
  });

  it('delegates runs, a single run and the export', async () => {
    await call('GET /workflows/:id/runs', { params: { id: 'w1' } });
    await call('GET /workflow-runs/:runId', { params: { runId: 'r1' } });
    await call('GET /workflows/:id/export', { params: { id: 'w1' } });
    expect(s.workflows.runs).toHaveBeenCalledWith('w1');
    expect(s.workflows.run).toHaveBeenCalledWith('r1');
    expect(s.workflows.export).toHaveBeenCalledWith('w1');
  });
});

describe('relay provisioning (ADR-BE-22)', () => {
  it('POST /instances/:id/relay/provision runs the pass and answers in counts', async () => {
    const result = await call('POST /instances/:id/relay/provision', {
      params: { id: 'i-1' },
    });

    // Whichever name the route was mounted under: provisioning must be aimed at the instance the
    // operator named, never at the whole fleet — and at every person on it, so no subject is sent.
    expect(s.accounts.provisionInstance).toHaveBeenCalledWith('i-1', undefined, {
      type: 'user',
      id: 'sub-1',
    });
    expect(result).toEqual({
      kind: 'body',
      body: {
        instanceId: 'i-1',
        enabled: true,
        configured: true,
        considered: 2,
        provisioned: 1,
        failed: 1,
      },
    });
  });

  it('reports a disabled relay as zero counts rather than as an error', async () => {
    s.accounts.provisionInstance.mockResolvedValueOnce({
      instanceId: 'i-1',
      enabled: false,
      configured: false,
      considered: 0,
      provisioned: 0,
      failed: 0,
    });

    const result = await call('POST /instances/:id/relay/provision', { params: { id: 'i-1' } });

    expect(result).toEqual({
      kind: 'body',
      body: {
        instanceId: 'i-1',
        enabled: false,
        configured: false,
        considered: 0,
        provisioned: 0,
        failed: 0,
      },
    });
  });

  it('attributes the pass to the operator, not to the role the process runs as', async () => {
    await call('POST /instances/:id/relay/provision', { params: { id: 'i-1' } });

    // A pass can create an account, reset a password or fail with `login_collision`; the audit row
    // it writes has to name the person who asked.
    const [, , actor] = s.accounts.provisionInstance.mock.calls[0] as [
      string,
      string | undefined,
      { type: string; id: string },
    ];
    expect(actor).toEqual({ type: 'user', id: 'sub-1' });
  });
});

describe('phase 2 handler registry', () => {
  it('implements every key exactly once', () => {
    expect(handlers.size).toBe(59);
    expect(new Set(handlers.keys()).size).toBe(handlers.size);
  });

  it('exposes only implemented keys through get()', () => {
    expect(handlers.get('GET /nope')).toBeUndefined();
  });

  it('refuses a missing path parameter on every parameterised route', async () => {
    const keys = [...handlers.keys()].filter((key) => key.includes(':'));
    for (const key of keys) {
      let error: unknown;
      try {
        await callHandler(handlers, key, operationInput(key, { params: {} }));
      } catch (caught) {
        error = caught;
      }
      expect(error, key).toBeInstanceOf(AppError);
      expect((error as AppError).code, key).toBe('VALIDATION_FAILED');
    }
  });
});
