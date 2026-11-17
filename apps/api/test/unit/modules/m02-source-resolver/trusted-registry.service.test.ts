import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, failingDb, type Route } from '../../../support/fakes';
import { PostgresTrustedRegistryService } from '../../../../src/modules/m02-source-resolver/trusted-registry.service';
import type {
  TrustedRegistriesReader,
  TrustedRegistrySnapshot,
} from '../../../../src/common/security/trusted-registries';

/**
 * NFR-4.16 — the allow-list's write side.
 *
 * Every change is a new revision plus an audit row inside one transaction. The cases below assert
 * the three refusals that keep it a control: a change that changes nothing, a change that would empty
 * the list (which would refuse the scanner's own image), and a boot without a revision table.
 */
const STATE_QUERY = 'FROM trusted_registry_revision';
const COUNT_QUERY = 'count(*)::int AS total';
const INSERT_QUERY = 'INSERT INTO trusted_registry_revision';

function revision(overrides: Record<string, unknown> = {}) {
  return {
    version: 3,
    content_hash: 'hash-3',
    entries: ['docker.io/library', 'ghcr.io/seamnex'],
    note: 'initial',
    created_by: 'usr-sofia',
    created_at: new Date('2026-11-01T10:00:00.000Z'),
    ...overrides,
  };
}

function setup(routes: readonly Route[] = []) {
  const db = fakeDb([
    ...routes,
    [COUNT_QUERY, [{ total: 1 }]],
    [STATE_QUERY, [revision()]],
    [INSERT_QUERY, []],
  ]);
  const audit = {
    lockChain: vi.fn(async () => undefined),
    append: vi.fn(async () => ({ seq: '1', hash: 'h' })),
  };
  const reader = {
    snapshot: vi.fn(async (): Promise<TrustedRegistrySnapshot> => ({
      version: 0,
      contentHash: '',
      entries: ['docker.io/library'],
      note: null,
      createdBy: 'platform',
      createdAt: new Date(0).toISOString(),
      origin: 'shipped',
    })),
    invalidate: vi.fn(),
  };
  const service = new PostgresTrustedRegistryService(
    db.pool,
    audit as never,
    reader as unknown as TrustedRegistriesReader,
  );
  return { db, audit, reader, service };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('state', () => {
  it('serves the newest revision as current and the rest as history', async () => {
    const { service } = setup([
      [STATE_QUERY, [revision(), revision({ version: 2, entries: ['docker.io/library'] })]],
    ]);

    const state = await service.state();

    expect(state.current).toEqual({
      version: 3,
      contentHash: 'hash-3',
      entries: ['docker.io/library', 'ghcr.io/seamnex'],
      note: 'initial',
      createdBy: 'usr-sofia',
      createdAt: '2026-11-01T10:00:00.000Z',
    });
    expect(state.history.map((entry) => [entry.version, entry.entryCount])).toEqual([
      [3, 2],
      [2, 1],
    ]);
  });

  it('drops a non-string member instead of trusting it as a namespace', async () => {
    const { service } = setup([
      [STATE_QUERY, [revision({ entries: ['ghcr.io', 7, { evil: true }] })]],
    ]);

    expect((await service.state()).current.entries).toEqual(['ghcr.io']);
  });

  it('reports an uninitialised list as unavailable rather than as an empty allow-list', async () => {
    const { service } = setup([[STATE_QUERY, []]]);

    await expect(service.state()).rejects.toThrow(/has no revision/);
  });

  it('exposes the entries for callers that only validate images', async () => {
    const { service } = setup();

    expect(await service.entries()).toEqual(['docker.io/library', 'ghcr.io/seamnex']);
  });
});

describe('update', () => {
  it('appends a revision, audits the change and invalidates the guard cache', async () => {
    const { audit, reader, service, db } = setup();

    const state = await service.update({
      actorId: 'usr-sofia',
      update: {
        add: ['ghcr.io/acme'],
        remove: [],
        note: 'Adding the Acme namespace for Metabase.',
      },
    });

    const insert = db.calls.find((call) => call.sql.includes(INSERT_QUERY));
    expect(insert?.params.slice(0, 2)).toEqual([4, expect.stringMatching(/^[0-9a-f]{64}$/)]);
    // Canonical form: sorted, so the stored list and its hash do not depend on argument order.
    expect(JSON.parse(String(insert?.params[2]))).toEqual([
      'docker.io/library',
      'ghcr.io/acme',
      'ghcr.io/seamnex',
    ]);

    expect(audit.lockChain).toHaveBeenCalledOnce();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'security.trusted_registry.updated',
        actorType: 'user',
        actorId: 'usr-sofia',
        targetId: '4',
        detail: expect.objectContaining({ added: ['ghcr.io/acme'], removed: [], entryCount: 3 }),
      }),
      expect.anything(),
    );
    // The revision is visible to the guard before the response leaves the process.
    expect(reader.invalidate).toHaveBeenCalled();
    expect(state.current.version).toBe(3);
  });

  it('records a removal, and ignores a namespace that was never on the list', async () => {
    const { audit, service } = setup();

    await service.update({
      actorId: 'usr-sofia',
      update: {
        add: [],
        remove: ['ghcr.io/seamnex', 'ghcr.io/never-present'],
        note: 'Removing the Seamnex namespace after the image review.',
      },
    });

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ added: [], removed: ['ghcr.io/seamnex'] }),
      }),
      expect.anything(),
    );
  });

  it('refuses a change that changes nothing, naming the revision it matches', async () => {
    const { service } = setup();

    await expect(
      service.update({
        actorId: 'usr-sofia',
        update: { add: ['ghcr.io/seamnex'], remove: [], note: 'Re-adding an existing namespace.' },
      }),
    ).rejects.toThrow(/already matches that change \(version 3\)/);
  });

  it('refuses a change that would empty the list, because it would refuse every image', async () => {
    const { service } = setup([[STATE_QUERY, [revision({ entries: ['ghcr.io/seamnex'] })]]]);

    await expect(
      service.update({
        actorId: 'usr-sofia',
        update: { add: [], remove: ['ghcr.io/seamnex'], note: 'Clearing the allow-list entirely.' },
      }),
    ).rejects.toThrow(/would leave the trusted-registry allow-list empty/);
  });

  it('skips an entry the parser cannot read rather than storing it unenforceable', async () => {
    const { audit, service } = setup();

    await service.update({
      actorId: 'usr-sofia',
      // The contract refuses this shape; the service is defensive because a direct caller is not the
      // only path that reaches it. The valid entry beside it is what proves the invalid one was
      // dropped rather than the whole change being abandoned.
      update: {
        add: ['docker.io/library/redis', 'ghcr.io/acme'],
        remove: [],
        note: 'A reference is not a namespace, so only the namespace is stored.',
      },
    });

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ added: ['ghcr.io/acme'] }) }),
      expect.anything(),
    );
  });
});

describe('the baseline revision', () => {
  it('writes revision 1 from the shipped document when the table is empty', async () => {
    const { db, reader, service } = setup([[COUNT_QUERY, [{ total: 0 }]]]);

    await service.state();

    const insert = db.calls.find((call) => call.sql.includes(INSERT_QUERY));
    expect(JSON.parse(String(insert?.params[1]))).toEqual(['docker.io/library']);
    expect(insert?.params[2]).toContain('packages/db/src/seed/trusted-registries.json');
    expect(reader.invalidate).toHaveBeenCalled();
  });

  it('names SEAMNEX_TRUSTED_REGISTRIES as the source when the configuration provided the list', async () => {
    const { db, reader, service } = setup([[COUNT_QUERY, [{ total: 0 }]]]);
    reader.snapshot.mockResolvedValue({
      version: 0,
      contentHash: '',
      entries: ['ghcr.io/acme'],
      note: null,
      createdBy: 'platform',
      createdAt: new Date(0).toISOString(),
      origin: 'configuration',
    });

    await service.state();

    const insert = db.calls.find((call) => call.sql.includes(INSERT_QUERY));
    expect(insert?.params[2]).toContain('SEAMNEX_TRUSTED_REGISTRIES');
  });

  it('writes nothing when there is no shipped list at all', async () => {
    const { db } = setup([[COUNT_QUERY, [{ total: 0 }]]]);
    const { reader } = { reader: { snapshot: async () => ({ entries: [] }) } };
    const isolated = new PostgresTrustedRegistryService(
      db.pool,
      { lockChain: vi.fn(), append: vi.fn() } as never,
      reader as never,
    );

    await isolated.state();

    expect(db.calls.some((call) => call.sql.includes(INSERT_QUERY))).toBe(false);
  });

  it('logs a boot failure instead of refusing to start over one reference table', async () => {
    const db = failingDb(new Error('relation "trusted_registry_revision" does not exist'));
    const service = new PostgresTrustedRegistryService(
      db.pool,
      { lockChain: vi.fn(), append: vi.fn() } as never,
      { snapshot: vi.fn(), invalidate: vi.fn() } as never,
    );

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});
