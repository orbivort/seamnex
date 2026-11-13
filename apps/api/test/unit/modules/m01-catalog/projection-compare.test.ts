import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '@seamnex/domain';
import {
  canonical,
  preserveVerifiedFacts,
  sameProjection,
  type StoredProjection,
} from '../../../../src/modules/m01-catalog/projection-compare';

/**
 * A reload re-projects the repository document, but the document describes what the *upstream
 * project* claims — it cannot know what an operator verified against the running product. These
 * cases pin both halves: the comparison must notice a stale column (a revision hash alone cannot,
 * because `db:seed` rewrites rows without appending a revision), and the verified block must survive
 * a reload while everything the repository owns is refreshed.
 */
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
  } as CatalogEntry;
}

function stored(overrides: Partial<StoredProjection['columns']> = {}): StoredProjection {
  return {
    contentHash: 'hash',
    document: document() as unknown as Record<string, unknown>,
    columns: {
      domain: 'collaboration',
      product: 'EspoCRM',
      cluster: 'Core Operations',
      packaging: 'compose',
      guaranteeClass: 'native',
      repoUrl: 'https://example.test/espocrm',
      licenseId: 'AGPL-3.0',
      ...overrides,
    },
  };
}

describe('canonical', () => {
  it('orders object keys so a jsonb round trip compares equal to the file', () => {
    expect(JSON.stringify(canonical({ b: 1, a: { d: 2, c: 3 } }))).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it('leaves scalars and arrays as they are, but canonicalises inside arrays', () => {
    expect(canonical([{ b: 1, a: 2 }, null, 'x'])).toEqual([{ a: 2, b: 1 }, null, 'x']);
  });
});

describe('sameProjection', () => {
  it('accepts a row that still says what the repository says', () => {
    expect(sameProjection(stored(), document())).toBe(true);
  });

  it('rejects a row whose document drifted', () => {
    const drifted = stored();
    drifted.document = document({ imageDigest: 'sha256:other' }) as unknown as Record<
      string,
      unknown
    >;

    expect(sameProjection(drifted, document())).toBe(false);
  });

  it.each([
    ['domain', { domain: 'other' }],
    ['product', { product: 'Other' }],
    ['packaging', { packaging: 'dockerfile' as const }],
    ['guaranteeClass', { guaranteeClass: 'fa_header' as const }],
    ['repoUrl', { repoUrl: 'https://elsewhere.test' }],
    ['licenseId', { licenseId: 'MIT' }],
  ])('rejects a row whose %s column drifted, even with a matching document', (_field, columns) => {
    expect(sameProjection(stored(columns), document())).toBe(false);
  });

  it('rejects a row whose cluster column names another cluster', () => {
    expect(sameProjection(stored({ cluster: 'Revenue & Customer' }), document())).toBe(false);
  });

  it('accepts a NULL cluster, which is not drift', () => {
    // A row written before the column was populated falls back to the document in `project()`.
    expect(sameProjection(stored({ cluster: null }), document())).toBe(true);
  });
});

describe('preserveVerifiedFacts', () => {
  it('takes the repository document when nothing was verified yet', () => {
    expect(preserveVerifiedFacts(document(), {})).toEqual(document());
    expect(preserveVerifiedFacts(document(), { integration: { stale: true } })).toEqual(document());
  });

  it('carries the verified block forward and takes everything else from the repository', () => {
    const repository = document({
      imageDigest: 'sha256:newly-published',
      integration: { ...document().integration, operationInventory: [] },
    });
    const previous = {
      integration: {
        credentialGranularity: 'none',
        sessionMaxMinutes: 15,
        verifiedBy: 'bob',
        verifiedAt: '2026-02-02T00:00:00.000Z',
        nextReviewAt: '2026-05-02T00:00:00.000Z',
        stale: true,
      },
    };

    const merged = preserveVerifiedFacts(repository, previous);

    expect(merged.imageDigest).toBe('sha256:newly-published');
    expect(merged.integration).toMatchObject({
      // A corrected granularity must not be reverted by the next commit to the repository.
      credentialGranularity: 'none',
      sessionMaxMinutes: 15,
      verifiedBy: 'bob',
      verifiedAt: '2026-02-02T00:00:00.000Z',
      nextReviewAt: '2026-05-02T00:00:00.000Z',
      // Recomputed from the clock, never inherited.
      stale: false,
    });
  });

  it('falls back to the document for fields the stored verification does not name', () => {
    const repository = document();

    const merged = preserveVerifiedFacts(repository, {
      integration: {
        verifiedAt: '2026-02-02T00:00:00.000Z',
        sessionMaxMinutes: null,
      },
    });

    expect(merged.integration.credentialGranularity).toBe('scoped');
    expect(merged.integration.verifiedBy).toBe('alice');
    expect(merged.integration.nextReviewAt).toBe('2026-04-01T00:00:00.000Z');
    expect(merged.integration.sessionMaxMinutes).toBe(60);
  });

  it('does not mutate the document it was given', () => {
    const repository = document();
    const before = JSON.stringify(repository);

    preserveVerifiedFacts(repository, {
      integration: { verifiedAt: '2026-02-02T00:00:00.000Z', stale: true },
    });

    expect(JSON.stringify(repository)).toBe(before);
  });
});
