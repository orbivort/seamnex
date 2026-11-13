import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { RegistryFeedService } from '../../../../src/modules/m12-integration-registry/registry-feed.service';

/**
 * The projection's empty cases. An operation inventory can be absent from *both* places it is read
 * (the verified metadata and the entry document), and the canvas then has to receive an empty list
 * rather than `undefined` — a snapshot with a missing array fails the response schema for every
 * reader, not just the one product that has no operations.
 */
function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const db = fakeDb(routes);
  const outbox = { on: vi.fn(), dispatch: vi.fn() };
  const service = new RegistryFeedService(
    db.pool,
    { SEAMNEX_REGISTRY_STALE_DAYS: 30 } as unknown as AppConfig,
    outbox as never,
  );
  return { db, service };
}

function instanceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instance_id: 'inst-1',
    entry_key: 'espocrm',
    slug: 'crm',
    host: 'crm.example.test',
    payload: {},
    guarantee_class: null,
    auth_method: null,
    credential_granularity: 'none',
    operation_inventory: null,
    event_modes: null,
    document_operations: null,
    document_event_modes: null,
    verified_at: new Date(),
    next_review_at: null,
    product: 'EspoCRM',
    version: '7.4.1',
    owner: 'team-crm',
    ...overrides,
  };
}

describe('rebuild', () => {
  it('projects empty lists when neither the metadata nor the document inventories anything', async () => {
    const { db, service } = setup([
      ['FROM instance i', [instanceRow()]],
      ['INSERT INTO registry_snapshot', []],
      ['DELETE FROM registry_snapshot', []],
    ]);

    await service.rebuild();

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO registry_snapshot'));
    const payload = JSON.parse(String(insert?.params[1])) as Record<string, unknown>;
    // Both are arrays, never `undefined`: the snapshot is served straight into a schema.
    expect(payload).toMatchObject({ operations: [], eventModes: [] });
  });

  it('reports zero when the driver returns no row count', async () => {
    // `rowCount` is the count of the rows the statement touched; without it the honest answer is
    // "nothing was projected", not `NaN` in the log line that reports the backfill.
    const { service } = setup([
      ['FROM instance i', { rows: [], rowCount: undefined }],
      ['DELETE FROM registry_snapshot', []],
    ]);

    await expect(service.rebuild()).resolves.toBe(0);
  });
});
