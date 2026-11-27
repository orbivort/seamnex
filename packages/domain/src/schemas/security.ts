import { z } from 'zod';
import { normaliseRegistryEntry } from '../image-registry';
import { IdSchema, TimestampSchema } from './common';

/**
 * NFR-4.16 — the trusted-registry allow-list as the API and the console exchange it.
 *
 * The state is the newest revision plus a short history: "versioned" is the requirement's word, and
 * a screen that shows only today's list cannot answer *when* a namespace was allowed. Entries are
 * registry or registry/namespace strings; the parser that reads them is `image-registry.ts`, so the
 * wire shape and the enforcement cannot disagree.
 */
export const TRUSTED_REGISTRY_MAX_ENTRIES = 256;

export const TrustedRegistryEntrySchema = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .refine(
    (value) => normaliseRegistryEntry(value) !== null,
    'Use a registry or registry/namespace in lower case, e.g. "ghcr.io" or "docker.io/library".',
  );

export const TrustedRegistryRevisionSchema = z.object({
  version: z.number().int().positive(),
  contentHash: z.string().min(1),
  entries: z.array(TrustedRegistryEntrySchema),
  note: z.string().nullable(),
  createdBy: z.string().min(1),
  createdAt: TimestampSchema,
});

export const TrustedRegistryStateSchema = z.object({
  current: TrustedRegistryRevisionSchema,
  /** Newest first, capped; `entryCount` rather than the full list keeps the payload small. */
  history: z.array(
    z.object({
      version: z.number().int().positive(),
      createdAt: TimestampSchema,
      createdBy: z.string().min(1),
      note: z.string().nullable(),
      entryCount: z.number().int().nonnegative(),
    }),
  ),
});

/**
 * One audited change. `add` and `remove` are separate lists rather than a replacement so two
 * operators editing different namespaces do not overwrite each other, and the audit detail can name
 * exactly what moved. The note is required: NFR-4.16 makes adding an entry an audited change, and an
 * audit row reading "changed" answers nothing.
 */
export const TrustedRegistryUpdateSchema = z
  .object({
    add: z.array(TrustedRegistryEntrySchema).max(64).default([]),
    remove: z.array(TrustedRegistryEntrySchema).max(64).default([]),
    note: z.string().trim().min(10).max(500),
  })
  .superRefine((value, ctx) => {
    // Both lists are already validated, so comparing them case-folded is enough: the write path
    // stores the canonical form, and an overlap check that missed `GHCR.io` would let one revision
    // add and remove the same namespace.
    const fold = (entries: readonly string[]): string[] =>
      entries.map((entry) => entry.toLowerCase());
    const add = fold(value.add);
    const remove = fold(value.remove);

    if (add.length === 0 && remove.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['add'],
        message:
          'Add or remove at least one namespace; an empty revision would only re-sign the list.',
      });
    }

    const overlap = add.filter((entry) => remove.includes(entry));
    if (overlap.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['remove'],
        message: `These entries are in both lists: ${overlap.join(', ')}.`,
      });
    }
  });

/**
 * NFR-4.6 / S-10 — what a scan concluded. `passed` and `blocked` are verdicts; `error` is the
 * scanner's own failure and is deliberately not `passed`: "we could not look" is not "we looked and
 * found nothing", which is the defect the review recorded.
 */
export const SCAN_VERDICTS = ['passed', 'blocked', 'error'] as const;
export type ScanVerdict = (typeof SCAN_VERDICTS)[number];

export const SCAN_SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const;
export type ScanSeverity = (typeof SCAN_SEVERITIES)[number];

export const ImageScanSeverityCountsSchema = z.object({
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
});

export const ImageScanFindingSchema = z.object({
  /** Advisory or CVE identifier (`CVE-2026-0001`, `GHSA-…`). */
  id: z.string().min(1),
  package: z.string().min(1),
  installedVersion: z.string().min(1),
  /** `null` when upstream has not published a fix — still a finding, never downgraded to a pass. */
  fixedVersion: z.string().min(1).nullable(),
  severity: z.enum(SCAN_SEVERITIES),
  title: z.string().min(1),
  url: z.string().min(1).nullable(),
});

/** What the instance image list shows next to a digest; findings live behind the report route. */
export const ImageScanSummarySchema = z.object({
  verdict: z.enum(SCAN_VERDICTS),
  scanner: z.string().min(1),
  scannerVersion: z.string().min(1),
  scannedAt: TimestampSchema,
  severityCounts: ImageScanSeverityCountsSchema,
  /** Severities configured to block at the time of the scan, so the verdict stays explainable. */
  blockingSeverities: z.array(z.enum(SCAN_SEVERITIES)),
});

export const ImageScanReportSchema = ImageScanSummarySchema.extend({
  instanceId: IdSchema,
  imageRef: z.string().min(1),
  imageDigest: z.string().min(1),
  findings: z.array(ImageScanFindingSchema),
  /** Where the raw scanner report is retained (object key or path); `null` when only the summary exists. */
  reportKey: z.string().min(1).nullable(),
});

export type TrustedRegistryEntry = z.infer<typeof TrustedRegistryEntrySchema>;
export type TrustedRegistryRevision = z.infer<typeof TrustedRegistryRevisionSchema>;
export type TrustedRegistryState = z.infer<typeof TrustedRegistryStateSchema>;
export type TrustedRegistryUpdate = z.infer<typeof TrustedRegistryUpdateSchema>;
export type ImageScanSeverityCounts = z.infer<typeof ImageScanSeverityCountsSchema>;
export type ImageScanFinding = z.infer<typeof ImageScanFindingSchema>;
export type ImageScanSummary = z.infer<typeof ImageScanSummarySchema>;
export type ImageScanReport = z.infer<typeof ImageScanReportSchema>;
