import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntry } from '@seamnex/domain';
import { fakeDb, type Route } from '../../../support/fakes';
import { PostgresCatalogService } from '../../../../src/modules/m01-catalog/catalog.service';
import type { CatalogWorkingTree } from '../../../../src/modules/m22-catalog-repository/catalog-repo.contract';

/**
 * The catalog projection. Three properties are the ones that broke in the field and are asserted
 * here rather than described: one unparseable row must not take the list endpoint down with it
 * (it is reported and omitted), a reload must not report "unchanged" for a row that was rewritten
 * behind the revision table (`db:seed` does exactly that), and a rejected file must protect its key
 * from removal — otherwise a trailing comma deletes a product.
 */
const REVIEW_WINDOW_MS = 91 * 24 * 60 * 60 * 1000;

const LIST = 'OR lower(product) LIKE';
const FIND = 'FROM catalog_entry WHERE key = $1';
const CURRENT = 'AS content_hash';
const MISSING = 'SELECT e.key FROM catalog_entry e';
const PATCH_UPDATE = 'UPDATE catalog_entry SET payload = $2::jsonb';
const METADATA = 'INSERT INTO integration_metadata';

function document(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'D01-01',
    domain: 'collaboration',
    cluster: 'Core Operations',
    product: 'EspoCRM',
    description: 'CRM',
    repoUrl: 'https://example.test/espocrm',
    licenseId: 'AGPL-3.0',
    stack: 'php',
    imageRef: 'espocrm/espocrm:8.0.0',
    imageDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    upstream: {
      currentVersion: '8.0.0',
      latestVersion: '8.0.0',
      advisory: null,
      releaseUrl: 'https://example.test/espocrm/releases/8.0.0',
      checkedAt: '2026-01-01T00:00:00.000Z',
    },
    guaranteeClass: 'native',
    authMethod: 'oidc',
    packaging: 'compose',
    packagingSource: 'upstream',
    primaryInstanceId: null,
    sharedWith: [],
    httpPort: 80,
    resources: { cpu: 1, memoryMb: 512, diskMb: 1024 },
    dependencies: [],
    volumes: [],
    integration: {
      apiBaseUrl: 'https://crm.example.test/api',
      authMethod: 'oidc',
      guaranteeClassVerified: 'native',
      operationInventory: [],
      eventModes: [],
      credentialGranularity: 'scoped',
      sessionMaxMinutes: 60,
      sloSupported: true,
      verifiedBy: 'alice',
      verifiedAt: '2026-01-01T00:00:00.000Z',
      nextReviewAt: '2026-04-01T00:00:00.000Z',
      stale: false,
    },
    owner: { name: 'Team', team: 'core' },
    notes: 'notes',
    verifiedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function hashOf(entry: CatalogEntry): string {
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

/** A row as `list`/`entry` select it: overlay columns plus the stored document. */
function entryRow(entry: CatalogEntry, overrides: Record<string, unknown> = {}) {
  return {
    key: entry.key,
    domain: entry.domain,
    product: entry.product,
    cluster: entry.cluster,
    packaging: entry.packaging,
    guarantee_class: entry.guaranteeClass,
    payload: entry,
    ...overrides,
  };
}

/** A row as `currentProjections` selects it: the same, plus the last revision hash. */
function storedRow(entry: CatalogEntry, overrides: Record<string, unknown> = {}) {
  return {
    ...entryRow(entry),
    repo_url: entry.repoUrl,
    license_id: entry.licenseId,
    content_hash: hashOf(entry),
    ...overrides,
  };
}

function tree(overrides: Partial<CatalogWorkingTree> = {}): CatalogWorkingTree {
  return { revision: 'rev-1', documents: [document()], envSchemas: [], invalid: [], ...overrides };
}

/**
 * The write statements a reload or a metadata patch issues. Registered by default so a test asserts
 * on `db.calls` (what was written, with which params) instead of restating every statement.
 */
const WRITES: readonly Route[] = [
  ['INSERT INTO catalog_entry (', []],
  ['INSERT INTO catalog_entry_revision', []],
  ['DELETE FROM catalog_entry WHERE key', []],
  [PATCH_UPDATE, []],
  [METADATA, []],
];

function setup(routes: readonly Route[] = []) {
  const db = fakeDb([...routes, ...WRITES]);
  const audit = {
    lockChain: vi.fn(async () => undefined),
    append: vi.fn(async () => ({ seq: '1', hash: 'h' })),
  };
  const repository = {
    load: vi.fn(async () => tree()),
    recordDrift: vi.fn(async () => undefined),
    recordCommit: vi.fn(async () => undefined),
  };
  const outbox = {
    emit: vi.fn(async () => undefined),
    on: vi.fn(),
    claim: vi.fn(async () => []),
    dispatchBatch: vi.fn(async () => 0),
  };
  const service = new PostgresCatalogService(
    db.pool,
    audit as never,
    repository as never,
    outbox as never,
  );
  return { db, audit, repository, outbox, service };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('list', () => {
  it('passes the filter through as lower-cased search plus the two exact columns', async () => {
    const { db, service } = setup([[LIST, [entryRow(document())]]]);

    const entries = await service.list({
      q: 'ESP',
      cluster: 'Core Operations',
      packaging: 'compose',
    });

    expect(db.calls[0]?.params).toEqual(['esp', 'Core Operations', 'compose']);
    expect(entries).toEqual([document()]);
  });

  it('orders by domain and product ordinal, so a legacy key cannot jump the queue', async () => {
    // ADR-BE-20 phase 1: 'D' + '3' sorts after 'D' + '0', so plain `ORDER BY key` pushes every legacy
    // key behind every composed one and the list silently reorders. The expression is deleted again
    // in phase 3, when every key is fixed-width and plain ordering is correct.
    const { db, service } = setup([[LIST, []]]);

    await service.list({});

    const sql = db.calls[0]?.sql ?? '';
    expect(sql).toContain("CASE WHEN position('-' in key) > 0 THEN substr(key, 2, 2)::int");
    expect(sql).toContain(
      "CASE WHEN position('-' in key) > 0 THEN substr(key, 5, 2)::int ELSE 1 END",
    );
    expect(sql).not.toMatch(/ORDER BY\s+key\b/);
  });

  it('sends empty strings for an absent filter, so the SQL predicates short-circuit', async () => {
    const { db, service } = setup([[LIST, []]]);

    await expect(service.list({})).resolves.toEqual([]);

    expect(db.calls[0]?.params).toEqual(['', '', '']);
  });

  it('omits a row whose stored document fails the contract, and reports it', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockReturnValue(undefined);
    const { service } = setup([
      [
        LIST,
        [
          entryRow(document()),
          // Missing everything the document is supposed to carry: the row survives, the entry does
          // not, and the screen can still render the ones that parse.
          {
            key: 'D02-01',
            domain: 'x',
            product: 'y',
            cluster: null,
            packaging: 'compose',
            guarantee_class: 'native',
            payload: { cluster: 'Core Operations' },
          },
        ],
      ],
    ]);

    const entries = await service.list({});

    expect(entries.map((entry) => entry.key)).toEqual(['D01-01']);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'catalog projection does not match the entry contract',
        key: 'D02-01',
      }),
    );
    // The reason names the offending field, so a stale row is diagnosable from the log alone.
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      detail: expect.stringContaining('description:'),
    });
  });

  it('ignores a NULL cluster column and keeps the cluster the document names', async () => {
    // A row written before the column was populated is still readable.
    const { service } = setup([[LIST, [entryRow(document(), { cluster: null })]]]);

    const [entry] = await service.list({});

    expect(entry?.cluster).toBe('Core Operations');
  });

  it('omits a row with no stored document at all', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockReturnValue(undefined);
    const { service } = setup([[LIST, [entryRow(document(), { payload: null })]]]);

    await expect(service.list({})).resolves.toEqual([]);
    expect(error).toHaveBeenCalledOnce();
  });
});

describe('entry', () => {
  it('projects the stored document over the relational row', async () => {
    const { db, service } = setup([[FIND, [entryRow(document())]]]);

    const entry = await service.entry('D01-01');

    expect(db.calls[0]?.params).toEqual(['D01-01']);
    expect(entry.product).toBe('EspoCRM');
    expect(entry.integration.credentialGranularity).toBe('scoped');
  });

  it('refuses an unknown key with the key and the repair in the message', async () => {
    const { service } = setup([[FIND, []]]);

    await expect(service.entry('D09-01')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No catalog entry D09-01.',
      remediation: 'Reload the catalog repository or check the entry key.',
      // The service leaves `status` to the HTTP layer's code→status catalogue.
      status: undefined,
    });
  });

  it('refuses a row that exists but is projected without the fields the contract requires', async () => {
    const { service } = setup([[FIND, [entryRow(document(), { payload: { key: 'D01-01' } })]]]);

    await expect(service.entry('D01-01')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'Catalog entry D01-01 is projected without the fields its contract requires.',
      remediation:
        'Run POST /catalog/reload to re-read the catalog repository, or reseed the development database.',
    });
  });
});

describe('reload', () => {
  it('reports the legacy keys it loaded instead of refusing them', async () => {
    // ADR-BE-20 phase 1: the receipt is the only place an operator learns a tree is mid-migration,
    // and phase 2's "reload and read the receipt" step asserts this list is empty afterwards.
    const { service } = setup([
      [CURRENT, []],
      [MISSING, []],
    ]);

    const result = await service.reload({
      actorId: 'actor-1',
      tree: tree({ documents: [document({ key: 'D3' }), document({ key: 'D03-02' })] }),
    });

    expect(result.deprecated).toEqual(['D3']);
  });

  it('adds a document that has never been projected', async () => {
    const { db, audit, repository, service } = setup([
      [CURRENT, []],
      [MISSING, []],
    ]);
    const entry = document();

    const result = await service.reload({ actorId: 'actor-1', tree: tree({ documents: [entry] }) });

    expect(result).toMatchObject({
      revision: 'rev-1',
      entries: 1,
      added: 1,
      changed: 0,
      removed: 0,
    });
    expect(result.reconciled).toEqual([
      {
        key: 'D01-01',
        change: 'added',
        detail: `Projected from revision rev-1; content hash ${hashOf(entry).slice(0, 12)}.`,
      },
    ]);
    // The verified block is carried forward even on an insert: nothing was verified, so the
    // document is written as the repository declared it.
    const upsert = db.calls.find((call) => call.sql.includes('INSERT INTO catalog_entry ('));
    expect(upsert?.params.slice(0, 6)).toEqual([
      'D01-01',
      'collaboration',
      'EspoCRM',
      'Core Operations',
      'compose',
      'native',
    ]);
    const revision = db.calls.find((call) =>
      call.sql.includes('INSERT INTO catalog_entry_revision'),
    );
    expect(revision?.params).toEqual(['D01-01', 'rev-1', hashOf(entry), JSON.stringify(entry)]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'catalog.reloaded',
        actorId: 'actor-1',
        targetId: 'D01-01',
        detail: { change: 'added', revision: 'rev-1', repaired: false },
      }),
      db.client,
    );
    expect(repository.recordDrift).not.toHaveBeenCalled();
  });

  it('leaves an unchanged entry alone', async () => {
    const { db, audit, service } = setup([
      [CURRENT, [storedRow(document())]],
      [MISSING, []],
    ]);

    const result = await service.reload({ actorId: 'actor-1', tree: tree() });

    expect(result).toMatchObject({ entries: 1, added: 0, changed: 0, removed: 0 });
    expect(result.reconciled).toEqual([
      { key: 'D01-01', change: 'unchanged', detail: 'Matches revision rev-1.' },
    ]);
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO catalog_entry ('))).toBe(false);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('updates an entry whose content moved and records the drift it observed', async () => {
    const { audit, repository, service } = setup([
      [CURRENT, [storedRow(document(), { content_hash: 'previous-hash' })]],
      [MISSING, []],
    ]);
    const entry = document();

    const result = await service.reload({ actorId: 'actor-1', tree: tree({ documents: [entry] }) });

    expect(result).toMatchObject({ added: 0, changed: 1 });
    expect(result.reconciled[0]?.detail).toBe(
      `Projected from revision rev-1; content hash ${hashOf(entry).slice(0, 12)}.`,
    );
    expect(repository.recordDrift).toHaveBeenCalledWith('D01-01', 'previous-hash', hashOf(entry));
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { change: 'updated', revision: 'rev-1', repaired: false },
      }),
      expect.anything(),
    );
  });

  it('repairs a projection whose row drifted behind a matching revision, without recording drift', async () => {
    // `pnpm db:seed` rewrites `catalog_entry` without appending a revision: the hash matches and the
    // row is still wrong. The columns are the only thing that can notice.
    const { audit, repository, service } = setup([
      [CURRENT, [storedRow(document(), { domain: 'seeded-wrong' })]],
      [MISSING, []],
    ]);

    const result = await service.reload({ actorId: 'actor-1', tree: tree() });

    expect(result).toMatchObject({ added: 0, changed: 1 });
    expect(result.reconciled[0]?.detail).toBe(
      'Projection repaired from revision rev-1; the stored row did not match the repository.',
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { change: 'updated', revision: 'rev-1', repaired: true } }),
      expect.anything(),
    );
    expect(repository.recordDrift).not.toHaveBeenCalled();
  });

  it('treats a row with no document and no revision as needing a projection', async () => {
    const { repository, service } = setup([
      [CURRENT, [storedRow(document(), { payload: null, content_hash: null })]],
      [MISSING, []],
    ]);

    const result = await service.reload({ actorId: 'actor-1', tree: tree() });

    expect(result.changed).toBe(1);
    // No revision hash to compare against, so the observed hash is reported from an empty baseline.
    expect(repository.recordDrift).toHaveBeenCalledWith('D01-01', '', hashOf(document()));
  });

  it('removes an absent entry but protects the key of a rejected file', async () => {
    const invalid = [
      {
        path: 'catalog/env/D02-01.json',
        scope: 'environment' as const,
        key: 'D02-01',
        reason: 'bad env',
      },
      { path: 'catalog/notes.json', scope: 'entry' as const, key: null, reason: 'not an entry' },
      {
        path: 'catalog/D03-01.json',
        scope: 'entry' as const,
        key: 'D03-01',
        reason: 'trailing comma',
      },
    ];
    const { db, audit, service } = setup([
      [CURRENT, []],
      [MISSING, [{ key: 'D09-01' }]],
    ]);

    const result = await service.reload({
      actorId: 'actor-1',
      tree: tree({ documents: [], invalid }),
    });

    expect(result).toMatchObject({ entries: 0, added: 0, changed: 0, removed: 1 });
    expect(result.invalid).toEqual(invalid);
    expect(result.reconciled).toEqual([
      { key: 'D09-01', change: 'removed', detail: 'No longer present in the working tree.' },
    ]);
    // Only the rejected *entry* with a key protects anything; an env file or a stray filename does not.
    const removals = db.calls.find((call) => call.sql.includes(MISSING));
    expect(removals?.params).toEqual([[], ['D03-01']]);
    expect(db.calls.some((call) => call.sql.includes('DELETE FROM catalog_entry WHERE key'))).toBe(
      true,
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'catalog.entry.removed',
        targetId: 'D09-01',
        detail: { reason: 'absent from the working tree' },
      }),
      expect.anything(),
    );
  });

  it('reads the working tree itself when the caller supplies none', async () => {
    const { repository, service } = setup([
      [CURRENT, []],
      [MISSING, []],
    ]);
    repository.load.mockResolvedValue(tree({ revision: 'rev-9' }));

    const result = await service.reload({ actorId: 'actor-1' });

    expect(repository.load).toHaveBeenCalledOnce();
    expect(result.revision).toBe('rev-9');
  });
});

describe('patchIntegrationMetadata', () => {
  it('refuses an unknown key', async () => {
    const { service, audit } = setup([[FIND, []]]);

    await expect(
      service.patchIntegrationMetadata('D09-01', { credentialGranularity: 'none' }, 'actor-1'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No catalog entry D09-01.',
    });
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('refuses to write back a partial document', async () => {
    const { service } = setup([[FIND, [entryRow(document(), { payload: { key: 'D01-01' } })]]]);

    await expect(
      service.patchIntegrationMetadata('D01-01', { credentialGranularity: 'none' }, 'actor-1'),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'Catalog entry D01-01 is projected without the fields its contract requires.',
    });
  });

  it('refuses a granularity that is not one of scoped, account or none', async () => {
    const { db, service } = setup([[FIND, [entryRow(document())]]]);

    const failure = service.patchIntegrationMetadata(
      'D01-01',
      { credentialGranularity: 'partial' as never },
      'actor-1',
    );

    await expect(failure).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: '"partial" is not a credential granularity.',
      fieldErrors: [
        { field: 'credentialGranularity', code: 'enum', message: 'One of scoped, account, none.' },
      ],
      remediation: 'Send scoped, account or none.',
    });
    // Nothing is written for a refused value.
    expect(db.calls.some((call) => call.sql.includes(PATCH_UPDATE))).toBe(false);
  });

  it('records a downgrade that revokes live write scopes and emits the registry rebuild', async () => {
    const { db, audit, outbox, service } = setup([[FIND, [entryRow(document())]]]);

    const entry = await service.patchIntegrationMetadata(
      'D01-01',
      { credentialGranularity: 'none' },
      'actor-1',
    );

    expect(entry.integration).toMatchObject({
      credentialGranularity: 'none',
      sessionMaxMinutes: 60,
      verifiedBy: 'actor-1',
      stale: false,
    });
    // A verification restarts the review clock: 13 weeks from the moment it was recorded.
    expect(
      Date.parse(entry.integration.nextReviewAt) - Date.parse(entry.integration.verifiedAt),
    ).toBe(REVIEW_WINDOW_MS);
    expect(entry.integration.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

    const update = db.calls.find((call) => call.sql.includes(PATCH_UPDATE));
    expect(update?.params[0]).toBe('D01-01');
    expect(JSON.parse(String(update?.params[1]))).toMatchObject({
      key: 'D01-01',
      integration: { credentialGranularity: 'none', verifiedBy: 'actor-1' },
    });

    // The per-instance record the enforcement points read, not only the entry document.
    const metadata = db.calls.find((call) => call.sql.includes(METADATA));
    expect(metadata?.params).toEqual([
      'D01-01',
      'none',
      60,
      'actor-1',
      new Date(entry.integration.verifiedAt),
      new Date(entry.integration.nextReviewAt),
    ]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'catalog.integration_metadata.updated',
        detail: {
          credentialGranularity: 'none',
          previousGranularity: 'scoped',
          writeEligible: false,
          revokesLiveWriteScopes: true,
          sessionMaxMinutes: 60,
          nextReviewAt: entry.integration.nextReviewAt,
        },
      }),
      db.client,
    );
    expect(outbox.emit).toHaveBeenCalledWith(db.client, {
      aggregateType: 'catalog_entry',
      aggregateId: 'D01-01',
      eventType: 'registry.rebuild',
      payload: { reason: 'integration_metadata.updated', entryKey: 'D01-01' },
    });
  });

  it('records a granularity change that restores write eligibility as non-revoking', async () => {
    const { audit, service } = setup([
      [
        FIND,
        [
          entryRow(
            document({ integration: { ...document().integration, credentialGranularity: 'none' } }),
          ),
        ],
      ],
    ]);

    const entry = await service.patchIntegrationMetadata(
      'D01-01',
      { credentialGranularity: 'account' },
      'actor-1',
    );

    expect(entry.integration.credentialGranularity).toBe('account');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          credentialGranularity: 'account',
          previousGranularity: 'none',
          writeEligible: false,
          revokesLiveWriteScopes: false,
        }),
      }),
      expect.anything(),
    );
  });

  it('leaves the granularity and the session budget alone when the patch omits both', async () => {
    const { db, audit, service } = setup([[FIND, [entryRow(document())]]]);

    const entry = await service.patchIntegrationMetadata('D01-01', {}, 'actor-1');

    expect(entry.integration.credentialGranularity).toBe('scoped');
    expect(entry.integration.sessionMaxMinutes).toBe(60);
    expect(db.calls.find((call) => call.sql.includes(METADATA))?.params[2]).toBe(60);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          previousGranularity: 'scoped',
          writeEligible: true,
          revokesLiveWriteScopes: false,
        }),
      }),
      expect.anything(),
    );
  });

  it('applies a session budget without touching the granularity', async () => {
    const { db, service } = setup([[FIND, [entryRow(document())]]]);

    const entry = await service.patchIntegrationMetadata(
      'D01-01',
      { sessionMaxMinutes: 15 },
      'actor-1',
    );

    expect(entry.integration.sessionMaxMinutes).toBe(15);
    expect(entry.integration.credentialGranularity).toBe('scoped');
    expect(db.calls.find((call) => call.sql.includes(METADATA))?.params.slice(1, 3)).toEqual([
      'scoped',
      15,
    ]);
  });
});
