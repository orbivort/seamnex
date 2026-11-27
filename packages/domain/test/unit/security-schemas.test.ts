import { describe, expect, it } from 'vitest';
import { normaliseRegistryEntry } from '../../src/image-registry';
import {
  ImageScanFindingSchema,
  ImageScanReportSchema,
  ImageScanSummarySchema,
  TrustedRegistryEntrySchema,
  TrustedRegistryStateSchema,
  TrustedRegistryUpdateSchema,
  SCAN_SEVERITIES,
} from '../../src/schemas/security';

/**
 * NFR-4.16 / NFR-4.6 — the wire shapes the API and the console agree on.
 *
 * Two properties are load-bearing: an allow-list entry is validated by the same parser the guard
 * uses (so a namespace cannot be stored that the enforcement could never match), and a scan summary
 * distinguishes `error` from `passed` — "we could not look" must not be representable as "clean".
 */
const digest = `sha256:${'a'.repeat(64)}`;

const summary = {
  verdict: 'blocked' as const,
  scanner: 'aquasec/trivy',
  scannerVersion: '0.58.0',
  scannedAt: '2026-11-01T10:00:00.000Z',
  severityCounts: { critical: 2, high: 5, medium: 1, low: 0, unknown: 0 },
  blockingSeverities: ['critical'],
};

describe('TrustedRegistryEntrySchema', () => {
  it('accepts a registry and a registry/namespace, trimmed', () => {
    expect(TrustedRegistryEntrySchema.parse(' ghcr.io ')).toBe('ghcr.io');
    expect(TrustedRegistryEntrySchema.parse('docker.io/library')).toBe('docker.io/library');
  });

  it('refuses an image reference, a deeper path and a too-short entry', () => {
    expect(TrustedRegistryEntrySchema.safeParse('docker.io/library/redis').success).toBe(false);
    expect(TrustedRegistryEntrySchema.safeParse('ghcr.io/a/b').success).toBe(false);
    expect(TrustedRegistryEntrySchema.safeParse('a').success).toBe(false);
  });

  it('tolerates a mixed-case entry because the write path stores the canonical form', () => {
    // Validation is against `normaliseRegistryEntry`, and `TrustedRegistryUpdateSchema` maps through
    // the same function, so what reaches the table is lower case either way.
    expect(TrustedRegistryEntrySchema.safeParse('GHCR.io/Seamnex').success).toBe(true);
    expect(normaliseRegistryEntry('GHCR.io/Seamnex')).toBe('ghcr.io/seamnex');
  });
});

describe('TrustedRegistryUpdateSchema', () => {
  const note = 'Adding the Metabase namespace after the image review.';

  it('defaults both lists and accepts an addition', () => {
    const parsed = TrustedRegistryUpdateSchema.parse({ add: ['ghcr.io/seamnex'], note });

    expect(parsed.add).toEqual(['ghcr.io/seamnex']);
    expect(parsed.remove).toEqual([]);
  });

  it('refuses a revision that changes nothing', () => {
    // "An empty revision would only re-sign the list" — no audit value, and no new evidence.
    const result = TrustedRegistryUpdateSchema.safeParse({ note });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('Add or remove at least one namespace');
  });

  it('accepts a removal on its own', () => {
    const parsed = TrustedRegistryUpdateSchema.parse({ remove: ['ghcr.io/seamnex'], note });

    expect(parsed.add).toEqual([]);
    expect(parsed.remove).toEqual(['ghcr.io/seamnex']);
  });

  it('detects an overlap regardless of the case each side was typed in', () => {
    const result = TrustedRegistryUpdateSchema.safeParse({
      add: ['GHCR.io/Seamnex'],
      remove: ['ghcr.io/seamnex'],
      note,
    });

    expect(result.success).toBe(false);
  });

  it('refuses the same namespace in both lists', () => {
    const result = TrustedRegistryUpdateSchema.safeParse({
      add: ['ghcr.io/seamnex'],
      remove: ['ghcr.io/seamnex'],
      note,
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('in both lists');
  });

  it('requires a note long enough to answer what changed', () => {
    expect(
      TrustedRegistryUpdateSchema.safeParse({ add: ['ghcr.io/seamnex'], note: 'added' }).success,
    ).toBe(false);
  });
});

describe('TrustedRegistryStateSchema', () => {
  it('accepts a state with history and refuses a missing current revision', () => {
    const state = {
      current: {
        version: 3,
        contentHash: 'abc123',
        entries: ['docker.io/library'],
        note: null,
        createdBy: 'usr-sofia',
        createdAt: '2026-11-01T10:00:00.000Z',
      },
      history: [
        {
          version: 3,
          createdAt: '2026-11-01T10:00:00.000Z',
          createdBy: 'usr-sofia',
          note: null,
          entryCount: 1,
        },
      ],
    };

    expect(TrustedRegistryStateSchema.parse(state).current.version).toBe(3);
    expect(TrustedRegistryStateSchema.safeParse({ history: [] }).success).toBe(false);
  });
});

describe('scan schemas', () => {
  it('accepts a summary and keeps the blocking severities as a list', () => {
    expect(ImageScanSummarySchema.parse(summary).blockingSeverities).toEqual(['critical']);
  });

  it('refuses a verdict outside passed | blocked | error', () => {
    expect(ImageScanSummarySchema.safeParse({ ...summary, verdict: 'clean' }).success).toBe(false);
    expect(ImageScanSummarySchema.safeParse({ ...summary, verdict: 'error' }).success).toBe(true);
  });

  it('accepts a report with findings and a null fix version', () => {
    const report = ImageScanReportSchema.parse({
      ...summary,
      instanceId: '3f1c4a2e-5f6b-4a7c-8d9e-0a1b2c3d4e5f',
      imageRef: 'docker.io/bitnami/redis:7.2.5',
      imageDigest: digest,
      reportKey: 'scans/inst-1/sha256-aaa.json',
      findings: [
        {
          id: 'CVE-2026-0001',
          package: 'openssl',
          installedVersion: '3.0.1',
          fixedVersion: null,
          severity: 'critical',
          title: 'Buffer overread in the TLS record layer',
          url: 'https://osv.dev/vulnerability/CVE-2026-0001',
        },
      ],
    });

    expect(report.findings[0]?.fixedVersion).toBeNull();
    expect(report.findings[0]?.severity).toBe('critical');
  });

  it('refuses a finding without a package or with an unknown severity', () => {
    const finding = {
      id: 'CVE-2026-0001',
      package: 'openssl',
      installedVersion: '3.0.1',
      fixedVersion: '3.0.2',
      severity: 'critical',
      title: 'Buffer overread',
      url: null,
    };

    expect(ImageScanFindingSchema.safeParse({ ...finding, package: '' }).success).toBe(false);
    expect(ImageScanFindingSchema.safeParse({ ...finding, severity: 'severe' }).success).toBe(
      false,
    );
  });

  it('names the severity vocabulary the scanner maps into', () => {
    expect([...SCAN_SEVERITIES]).toEqual(['critical', 'high', 'medium', 'low', 'unknown']);
  });
});
