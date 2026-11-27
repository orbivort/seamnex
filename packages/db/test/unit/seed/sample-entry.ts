import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CREDENTIAL_GRANULARITIES,
  DOMAIN_CLUSTERS,
  GUARANTEE_CLASSES,
  PACKAGING_KINDS,
} from '@seamnex/domain';

/**
 * A synthetic catalogue document, for tests only.
 *
 * The documents this replaces were the vendored default set: real products, copied into the
 * repository as deployable content. ADR-BE-42 moved that content to the catalogue repository, so a
 * test that needs a checkout builds one from values no deployment can use — `example.invalid` hosts
 * and a "Fixture" product — instead of keeping a second copy of the catalogue here.
 *
 * Returned as a plain object rather than a typed `CatalogEntry` so a test can deliberately break one
 * field and assert the refusal; the shape is checked against the served schema where it matters
 * (`planTreeProjection` parses it with `CatalogEntrySchema`).
 */
export function sampleEntry(
  key: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key,
    domain: 'Testing & Fixtures',
    cluster: DOMAIN_CLUSTERS[0],
    product: `Fixture ${key}`,
    description: 'A synthetic catalogue document used only by the database test suite.',
    repoUrl: 'https://example.invalid/fixture',
    licenseId: 'MIT',
    stack: 'compose',
    imageRef: 'registry.example.invalid/fixture:1.0.0',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    upstream: {
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      advisory: null,
      releaseUrl: 'https://example.invalid/fixture/releases/1.0.0',
      checkedAt: '2026-01-01T00:00:00.000Z',
    },
    guaranteeClass: GUARANTEE_CLASSES[0],
    authMethod: 'oidc',
    packaging: PACKAGING_KINDS[0],
    packagingSource: 'example.invalid/fixture',
    primaryInstanceId: null,
    sharedWith: [],
    httpPort: 8080,
    resources: { cpu: 1, memoryMb: 512, diskMb: 1024 },
    dependencies: [],
    volumes: [],
    integration: {
      apiBaseUrl: 'https://fixture.example.invalid/api',
      authMethod: 'oidc',
      guaranteeClassVerified: GUARANTEE_CLASSES[0],
      operationInventory: [],
      eventModes: [],
      credentialGranularity: CREDENTIAL_GRANULARITIES[0],
      sessionMaxMinutes: 60,
      sloSupported: false,
      verifiedBy: 'test',
      verifiedAt: '2026-01-01T00:00:00.000Z',
      nextReviewAt: '2027-01-01T00:00:00.000Z',
      stale: false,
    },
    owner: { name: 'Fixture Owner', team: 'Platform', email: 'fixture@example.invalid' },
    notes: 'Synthetic fixture; never deployed.',
    verifiedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** One `catalog/env/<KEY>.json` the projector would apply. */
export function sampleDeclaration(key: string): Record<string, unknown> {
  return {
    format: 'env-schema/v1',
    entryKey: key,
    variables: [
      {
        name: 'FIXTURE_MODE',
        purpose: 'Test value',
        type: 'string',
        required: false,
        defaultValue: 'fixture',
        constraint: null,
        conditional: null,
        secret: false,
        overrideCeiling: 'profile_and_instance',
      },
    ],
  };
}

/** Writes `<root>/catalog/<KEY>.json` and `<root>/catalog/env/<KEY>.json` for each key. */
export function writeCheckout(root: string, keys: readonly string[]): void {
  const catalogDir = join(root, 'catalog');
  const envDir = join(catalogDir, 'env');
  mkdirSync(envDir, { recursive: true });
  for (const key of keys) {
    writeFileSync(
      join(catalogDir, `${key}.json`),
      JSON.stringify(sampleEntry(key), null, 2),
      'utf8',
    );
    writeFileSync(
      join(envDir, `${key}.json`),
      JSON.stringify(sampleDeclaration(key), null, 2),
      'utf8',
    );
  }
}
