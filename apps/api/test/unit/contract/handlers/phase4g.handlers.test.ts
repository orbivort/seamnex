import { beforeEach, describe, expect, it, vi } from 'vitest';
import { operationKey } from '@seamnex/domain';
import { Phase4GHandlers } from '../../../../src/contract/handlers/phase4g.handlers';
import type { OperationHandler } from '../../../../src/contract/operation-handler';

/**
 * The 4G group: five operations, no SQL.
 *
 * These handlers are thin on purpose — the tables belong to M02, M05 and M18 — so what is asserted is
 * the wiring that would otherwise fail at runtime: every declared operation resolves to a handler, the
 * actor reaches the audit trail, and a request without the digest an instance report needs is refused
 * as a validation error instead of a 500.
 */
const subject = { subject: { idpId: 'usr-sofia' } };

function handler(map: ReadonlyMap<string, OperationHandler>, method: string, path: string) {
  const found = map.get(operationKey({ method: method as never, path }));
  if (found === undefined) throw new Error(`${method} ${path} is not handled`);
  return found;
}

function setup() {
  const governance = {
    recordNativeFloorDecision: vi.fn(async () => ({
      floor: 4,
      reason: 'Accepting four native deployments while the migration runs.',
      recordedBy: 'usr-sofia',
      recordedAt: '2026-11-01T10:00:00.000Z',
    })),
  };
  const upstream = {
    observe: vi.fn(async () => ({ observedAt: '2026-11-01T10:00:00.000Z', entries: 6 })),
  };
  const registries = {
    state: vi.fn(async () => ({ current: { version: 3 }, history: [] })),
    update: vi.fn(async () => ({ current: { version: 4 }, history: [] })),
  };
  const scans = {
    report: vi.fn(async () => ({ imageDigest: 'sha256:abc', findings: [] })),
  };
  const group = new Phase4GHandlers(
    governance as never,
    upstream as never,
    registries as never,
    scans as never,
  );
  return { group, governance, upstream, registries, scans };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handlers', () => {
  it('declares the five operations the contract adds', () => {
    const { group } = setup();

    expect([...group.handlers().keys()]).toEqual([
      operationKey({ method: 'GET', path: '/instances/:id/image-scan' }),
      operationKey({ method: 'POST', path: '/patch-register/observe' }),
      operationKey({ method: 'POST', path: '/posture/native-floor/decision' }),
      operationKey({ method: 'GET', path: '/security/trusted-registries' }),
      operationKey({ method: 'POST', path: '/security/trusted-registries' }),
    ]);
    expect(group.tag).toBe('phase-4g');
  });

  it('answers the allow-list read with the state the guard is using', async () => {
    const { group, registries } = setup();

    const result = await handler(
      group.handlers(),
      'GET',
      '/security/trusted-registries',
    )({
      params: {},
      query: {},
      body: undefined,
      context: subject,
    } as never);

    expect(registries.state).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: 'body', body: { current: { version: 3 }, history: [] } });
  });

  it('attributes an allow-list revision to the caller, not to the platform', async () => {
    const { group, registries } = setup();
    const update = { add: ['ghcr.io/acme'], remove: [], note: 'Adding the Acme namespace.' };

    await handler(
      group.handlers(),
      'POST',
      '/security/trusted-registries',
    )({
      params: {},
      query: {},
      body: update,
      context: subject,
    } as never);

    expect(registries.update).toHaveBeenCalledWith({ actorId: 'usr-sofia', update });
  });

  it('attributes an on-demand observation to the operator who triggered it', async () => {
    const { group, upstream } = setup();

    await handler(
      group.handlers(),
      'POST',
      '/patch-register/observe',
    )({
      params: {},
      query: {},
      body: undefined,
      context: subject,
    } as never);

    expect(upstream.observe).toHaveBeenCalledWith({ type: 'user', id: 'usr-sofia' });
  });

  it('records a floor decision against the caller', async () => {
    const { group, governance } = setup();
    const request = {
      floor: 4,
      reason: 'Accepting four native deployments while the migration runs.',
    };

    const result = await handler(
      group.handlers(),
      'POST',
      '/posture/native-floor/decision',
    )({
      params: {},
      query: {},
      body: request,
      context: subject,
    } as never);

    expect(governance.recordNativeFloorDecision).toHaveBeenCalledWith(request, 'usr-sofia');
    expect(result).toMatchObject({ kind: 'body' });
  });

  it('answers the instance report for the digest in the query', async () => {
    const { group, scans } = setup();

    await handler(
      group.handlers(),
      'GET',
      '/instances/:id/image-scan',
    )({
      params: { id: 'inst-crm' },
      query: { digest: 'sha256:abc' },
      body: undefined,
      context: subject,
    } as never);

    expect(scans.report).toHaveBeenCalledWith('inst-crm', 'sha256:abc');
  });

  it('refuses a report request without a digest, with a field error naming the parameter', async () => {
    const { group, scans } = setup();

    await expect(
      handler(
        group.handlers(),
        'GET',
        '/instances/:id/image-scan',
      )({
        params: { id: 'inst-crm' },
        query: {},
        body: undefined,
        context: subject,
      } as never),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [expect.objectContaining({ field: 'digest' })],
    });
    expect(scans.report).not.toHaveBeenCalled();
  });

  it('treats a blank digest as missing', async () => {
    const { group } = setup();

    await expect(
      handler(
        group.handlers(),
        'GET',
        '/instances/:id/image-scan',
      )({
        params: { id: 'inst-crm' },
        query: { digest: '   ' },
        body: undefined,
        context: subject,
      } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a path without the instance id rather than querying for `undefined`', async () => {
    const { group, scans } = setup();

    await expect(
      handler(
        group.handlers(),
        'GET',
        '/instances/:id/image-scan',
      )({
        params: {},
        query: { digest: 'sha256:abc' },
        body: undefined,
        context: subject,
      } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('id') });
    expect(scans.report).not.toHaveBeenCalled();
  });
});
