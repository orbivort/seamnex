import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { RegistryFeedService } from '../../../../src/modules/m12-integration-registry/registry-feed.service';

/**
 * The registry feed is a projection, and its two failure modes are both historical: a snapshot that
 * advertises write eligibility the database would refuse (so the granularity comes from the same
 * resolver invariant 4 uses), and a snapshot row that outlives a soft-deleted instance (so the
 * rebuild deletes what no longer has a live instance). Staleness is asserted as a dated fact.
 */
const STALE_DAYS = 30;

function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const db = fakeDb(routes);
  const outbox = { on: vi.fn(), dispatch: vi.fn() };
  const config = { SEAMNEX_REGISTRY_STALE_DAYS: STALE_DAYS } as unknown as AppConfig;
  const service = new RegistryFeedService(db.pool, config, outbox as never);
  return { db, outbox, service };
}

function instanceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instance_id: 'inst-1',
    entry_key: 'espocrm',
    slug: 'crm',
    host: 'crm.example.test',
    // The shape `lifecycle.service.insertInstance` actually writes: the class travels inside
    // `route.authMode`, and there is no top-level `guaranteeClass`/`authMethod`. A fixture that
    // invented them is what let the projection default every product to `native`.
    payload: { version: '7.4', route: { authMode: 'native' } },
    guarantee_class: 'native',
    auth_method: 'oidc',
    credential_granularity: 'scoped',
    operation_inventory: [{ name: 'contact.read' }],
    event_modes: ['webhook'],
    document_operations: [{ name: 'document.read' }],
    document_event_modes: ['poll'],
    verified_at: new Date(),
    next_review_at: null,
    product: 'EspoCRM',
    version: '7.4.1',
    owner: 'team-crm',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('outbox wiring', () => {
  it('rebuilds when the durable event fires', async () => {
    const { outbox, service } = setup();

    let handler: (() => Promise<void>) | undefined;
    outbox.on.mockImplementation((_event: string, callback: () => Promise<void>) => {
      handler = callback;
    });
    service.onModuleInit();

    expect(outbox.on).toHaveBeenCalledWith('registry.rebuild', expect.any(Function));
    // The handler swallows a rebuild failure so a dispatcher does not retry a broken projection.
    vi.spyOn(service, 'rebuild').mockRejectedValue(new Error('projection failed'));
    await expect(handler?.()).resolves.toBeUndefined();
  });
});

describe('onApplicationBootstrap', () => {
  it('leaves a complete projection alone', async () => {
    const { service } = setup([['AS incomplete', [{ incomplete: false }]]]);
    const rebuild = vi.spyOn(service, 'rebuild');

    await service.onApplicationBootstrap();

    expect(rebuild).not.toHaveBeenCalled();
  });

  it('backfills a projection that was never built', async () => {
    const { db, service } = setup([
      ['AS incomplete', [{ incomplete: true }]],
      ['FROM instance i\n         LEFT JOIN', [instanceRow()]],
      ['INSERT INTO registry_snapshot', []],
      ['DELETE FROM registry_snapshot', []],
    ]);

    await service.onApplicationBootstrap();

    expect(db.calls.some((call) => call.sql.includes('INSERT INTO registry_snapshot'))).toBe(true);
  });

  it('keeps booting when the backfill fails', async () => {
    const { service } = setup([['AS incomplete', [{ incomplete: true }]]]);
    vi.spyOn(service, 'rebuild').mockRejectedValue(new Error('database down'));

    // A projection that cannot be built must not keep the API from serving.
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('keeps booting when the completeness probe fails', async () => {
    const { service } = setup([
      [
        'AS incomplete',
        () => {
          throw new Error('database down');
        },
      ],
    ]);

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});

describe('operations', () => {
  it('projects the discovered operations and event modes for a target', async () => {
    const { db, service } = setup([
      [
        'FROM registry_snapshot',
        [
          {
            entry_key: 'espocrm',
            payload: { operations: [{ name: 'a' }], eventModes: ['webhook'] },
          },
        ],
      ],
    ]);

    await expect(service.operations('crm')).resolves.toEqual({
      target: 'espocrm',
      operations: [{ name: 'a' }],
      eventModes: ['webhook'],
    });
    expect(db.calls[0]?.params).toEqual(['crm']);
  });

  it('defaults both lists when the snapshot carries neither', async () => {
    const { service } = setup([
      ['FROM registry_snapshot', [{ entry_key: 'espocrm', payload: {} }]],
    ]);

    await expect(service.operations('crm')).resolves.toEqual({
      target: 'espocrm',
      operations: [],
      eventModes: [],
    });
  });

  it('refuses an unknown target instead of guessing a URL', async () => {
    const { service } = setup([['FROM registry_snapshot', []]]);

    await expect(service.operations('nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No registry entry for "nope".',
    });
  });
});

describe('rebuild', () => {
  it('projects a fresh snapshot with the database-resolved granularity', async () => {
    const { db, service } = setup([
      ['FROM instance i\n         LEFT JOIN', [instanceRow()]],
      ['INSERT INTO registry_snapshot', []],
      ['DELETE FROM registry_snapshot', []],
    ]);

    const count = await service.rebuild();

    expect(count).toBe(1);
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO registry_snapshot'));
    const payload = JSON.parse(String(insert?.params[1])) as Record<string, unknown>;
    expect(payload).toMatchObject({
      instanceId: 'inst-1',
      entryKey: 'espocrm',
      product: 'EspoCRM',
      slug: 'crm',
      route: 'crm.example.test',
      version: '7.4.1',
      apiBaseUrl: 'https://crm.example.test',
      authMethod: 'oidc',
      guaranteeClass: 'native',
      credentialGranularity: 'scoped',
      writeEligible: true,
      workflowEligible: true,
      owner: 'team-crm',
      stale: false,
    });
    expect(insert?.params[2]).toBe(false);
    // The projection is the live instances and only those.
    expect(db.calls.some((call) => call.sql.includes('DELETE FROM registry_snapshot'))).toBe(true);
  });

  it('publishes a proxy gate as a gate, never as single sign-on', async () => {
    // D09-01 is `fa_gate`: the route requires a platform session and the product then asks for its
    // own password. The registry is what the workflow builder reads, and it used to report every
    // deployed product as `native` because it looked for a field `instance.payload` does not carry.
    const { db, service } = setup([
      [
        'FROM instance i\n         LEFT JOIN',
        [
          instanceRow({
            entry_key: 'D09-01',
            product: 'OpenProject',
            guarantee_class: 'fa_gate',
            auth_method: 'Proxy gate only',
            payload: { version: '17.9.6', route: { authMode: 'fa_gate' } },
          }),
        ],
      ],
      ['INSERT INTO registry_snapshot', []],
      ['DELETE FROM registry_snapshot', []],
    ]);

    await service.rebuild();

    expect(db.calls[0]?.sql).toContain('m.guarantee_class_verified');
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO registry_snapshot'));
    expect(JSON.parse(String(insert?.params[1]))).toMatchObject({
      guaranteeClass: 'fa_gate',
      authMethod: 'Proxy gate only',
    });
  });

  it('projects the version the entry pins, not the deploy-time placeholder', async () => {
    const { db, service } = setup([
      ['FROM instance i\n         LEFT JOIN', [instanceRow({ version: 'v10.0.11' })]],
      ['INSERT INTO registry_snapshot', []],
      ['DELETE FROM registry_snapshot', []],
    ]);

    await service.rebuild();

    // The pin comes from the entry document, which this module already reads; the running tag lives
    // on the instance screen, because `instance_service` is outside M12's declared reads.
    expect(db.calls[0]?.sql).toContain('upstream');
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO registry_snapshot'));
    // The tag carries a `v` the catalog does not; the column prints one canonical form.
    expect(JSON.parse(String(insert?.params[1]))).toMatchObject({ version: '10.0.11' });
  });

  it('falls back to the entry document for an unverified instance, and marks it stale', async () => {
    const { db, service } = setup([
      [
        'FROM instance i\n         LEFT JOIN',
        [
          instanceRow({
            host: null,
            credential_granularity: 'not-a-granularity',
            operation_inventory: null,
            event_modes: null,
            guarantee_class: null,
            auth_method: null,
            verified_at: null,
            next_review_at: null,
            product: null,
            version: null,
            owner: null,
            payload: {},
          }),
        ],
      ],
      ['INSERT INTO registry_snapshot', []],
      ['DELETE FROM registry_snapshot', []],
    ]);

    await service.rebuild();

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO registry_snapshot'));
    const payload = JSON.parse(String(insert?.params[1])) as Record<string, unknown>;
    expect(payload).toMatchObject({
      product: 'espocrm',
      route: '',
      apiBaseUrl: '',
      version: 'unpinned',
      authMethod: 'oidc',
      guaranteeClass: 'native',
      credentialGranularity: 'none',
      writeEligible: false,
      workflowEligible: false,
      owner: 'platform',
      stale: true,
      // Never verified: the epoch is the honest timestamp.
      verifiedAt: '1970-01-01T00:00:00.000Z',
      operations: [{ name: 'document.read' }],
      eventModes: ['poll'],
    });
  });

  it('ages a verification that is older than the staleness window', async () => {
    const old = new Date(Date.now() - (STALE_DAYS + 1) * 86_400_000);
    const { db, service } = setup([
      [
        'FROM instance i\n         LEFT JOIN',
        [instanceRow({ verified_at: old, next_review_at: null })],
      ],
      ['INSERT INTO registry_snapshot', []],
      ['DELETE FROM registry_snapshot', []],
    ]);

    await service.rebuild();

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO registry_snapshot'));
    const payload = JSON.parse(String(insert?.params[1])) as Record<string, unknown>;
    expect(payload.stale).toBe(true);
    // The next review is derived from the verification, not left empty.
    expect(payload.nextReviewAt).toBe(
      new Date(old.getTime() + STALE_DAYS * 86_400_000).toISOString(),
    );
  });

  it('honours a recorded next review date', async () => {
    const nextReview = new Date('2027-01-01T00:00:00Z');
    const { db, service } = setup([
      ['FROM instance i\n         LEFT JOIN', [instanceRow({ next_review_at: nextReview })]],
      ['INSERT INTO registry_snapshot', []],
      ['DELETE FROM registry_snapshot', []],
    ]);

    await service.rebuild();

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO registry_snapshot'));
    expect(JSON.parse(String(insert?.params[1]))).toMatchObject({
      nextReviewAt: '2027-01-01T00:00:00.000Z',
    });
  });

  it('keeps the verified inventory ahead of the entry document', async () => {
    const { db, service } = setup([
      ['FROM instance i\n         LEFT JOIN', [instanceRow()]],
      ['INSERT INTO registry_snapshot', []],
      ['DELETE FROM registry_snapshot', []],
    ]);

    await service.rebuild();

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO registry_snapshot'));
    expect(JSON.parse(String(insert?.params[1]))).toMatchObject({
      operations: [{ name: 'contact.read' }],
      eventModes: ['webhook'],
    });
  });

  it('reports zero when there are no live instances', async () => {
    const { service } = setup([
      ['FROM instance i\n         LEFT JOIN', []],
      ['DELETE FROM registry_snapshot', []],
    ]);

    await expect(service.rebuild()).resolves.toBe(0);
  });
});
