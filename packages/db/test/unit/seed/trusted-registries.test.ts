import { describe, expect, it } from 'vitest';
import {
  TRUSTED_REGISTRIES_DOCUMENT,
  TRUSTED_REGISTRY_FORMAT,
  loadShippedTrustedRegistries,
  normaliseTrustedRegistryEntries,
  parseTrustedRegistryDocument,
  trustedRegistryContentHash,
} from '../../../src/seed/trusted-registries';

/**
 * NFR-4.16 — the shipped allow-list document, and the hash that makes revisions comparable.
 *
 * Two properties are load-bearing. The canonical form (normalised, de-duplicated, sorted) is what
 * the content hash is taken over, so two operators adding the same namespaces in a different order
 * produce the same revision hash instead of a spurious "changed" row. And the document refuses an
 * empty or malformed list rather than starting the platform with a control that allows nothing.
 */
const document = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    format: TRUSTED_REGISTRY_FORMAT,
    version: 1,
    note: 'shipped default',
    entries: ['docker.io/library', 'ghcr.io/seamnex'],
    ...overrides,
  });

describe('normaliseTrustedRegistryEntries', () => {
  it('lower-cases, de-duplicates and sorts, so order cannot change the hash', () => {
    expect(
      normaliseTrustedRegistryEntries([
        ' ghcr.io/Seamnex ',
        'docker.io/library',
        'ghcr.io/seamnex',
      ]),
    ).toEqual(['docker.io/library', 'ghcr.io/seamnex']);
  });

  it('refuses an entry the parser cannot read instead of shipping it', () => {
    expect(() => normaliseTrustedRegistryEntries(['docker.io/library/redis'])).toThrow(
      /not a trusted-registry entry/,
    );
    expect(() => normaliseTrustedRegistryEntries([''])).toThrow(/not a trusted-registry entry/);
  });
});

describe('trustedRegistryContentHash', () => {
  it('is stable across ordering and casing', () => {
    const first = trustedRegistryContentHash(['docker.io/library', 'ghcr.io/seamnex']);
    const second = trustedRegistryContentHash(['GHCR.IO/Seamnex', 'docker.io/library']);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the list changes, which is what makes it a revision', () => {
    const before = trustedRegistryContentHash(['docker.io/library']);
    const after = trustedRegistryContentHash(['docker.io/library', 'ghcr.io/seamnex']);

    expect(before).not.toBe(after);
  });
});

describe('parseTrustedRegistryDocument', () => {
  it('accepts a document and returns the canonical entries', () => {
    const parsed = parseTrustedRegistryDocument(document(), 'doc.json');

    expect(parsed).toEqual({
      format: TRUSTED_REGISTRY_FORMAT,
      version: 1,
      note: 'shipped default',
      entries: ['docker.io/library', 'ghcr.io/seamnex'],
    });
  });

  it('defaults a missing note rather than failing the install over it', () => {
    expect(parseTrustedRegistryDocument(document({ note: undefined }), 'doc.json').note).toBe('');
  });

  it('refuses invalid JSON, naming the source', () => {
    expect(() => parseTrustedRegistryDocument('{', 'doc.json')).toThrow(
      /doc\.json is not valid JSON/,
    );
  });

  it('refuses anything that is not a JSON object', () => {
    for (const text of ['[]', '"entries"', 'null', '7']) {
      expect(() => parseTrustedRegistryDocument(text, 'doc.json'), text).toThrow(
        /must be a JSON object/,
      );
    }
  });

  it('refuses an unknown format and a non-positive version', () => {
    expect(() => parseTrustedRegistryDocument(document({ format: 'v2' }), 'doc.json')).toThrow(
      /declares format "v2"/,
    );
    for (const version of [0, -1, 1.5, '1']) {
      expect(
        () => parseTrustedRegistryDocument(document({ version }), 'doc.json'),
        `${version}`,
      ).toThrow(/positive integer version/);
    }
  });

  it('refuses an empty allow-list, because it would refuse every image', () => {
    expect(() => parseTrustedRegistryDocument(document({ entries: [] }), 'doc.json')).toThrow(
      /at least one entry/,
    );
    expect(() =>
      parseTrustedRegistryDocument(document({ entries: 'ghcr.io' }), 'doc.json'),
    ).toThrow(/at least one entry/);
  });

  it('refuses a non-string entry, quoting it', () => {
    expect(() => parseTrustedRegistryDocument(document({ entries: [7] }), 'doc.json')).toThrow(
      /non-string entry \(7\)/,
    );
  });
});

describe('the shipped document', () => {
  it('parses, and covers the namespaces the seeded products and the scanner pull from', () => {
    const shipped = loadShippedTrustedRegistries();

    expect(shipped.format).toBe(TRUSTED_REGISTRY_FORMAT);
    expect(shipped.version).toBeGreaterThanOrEqual(1);
    // The scanner image and Docker Hub's official namespaces are the two the pipeline cannot run
    // without; a default that omitted either would refuse the platform's own workloads.
    expect(shipped.entries).toContain('docker.io/aquasec');
    expect(shipped.entries).toContain('docker.io/library');
    expect(shipped.entries).toContain('ghcr.io/seamnex');
    expect(shipped.entries).toEqual([...shipped.entries].sort());
  });

  it('lives beside the loader rather than in a migration', () => {
    expect(TRUSTED_REGISTRIES_DOCUMENT.endsWith('trusted-registries.json')).toBe(true);
  });

  it('reads any path, so the loader can be pointed at a candidate document', () => {
    expect(
      loadShippedTrustedRegistries(TRUSTED_REGISTRIES_DOCUMENT).entries.length,
    ).toBeGreaterThan(0);
  });
});
