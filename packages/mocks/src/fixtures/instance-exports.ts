import type { InstanceExport } from '@seamnex/domain';
import { hoursAgo } from './context';

/**
 * Seeded exports, in the shape the capture actually writes (FR-1.13 / AC-20).
 *
 * Two per instance on purpose: one complete archive and one that deliberately lacks the definition,
 * so the "Not included" column is exercised by the demo rather than only by a test. The mock cannot
 * produce a real tar, so the download handler answers a small placeholder with the same headers —
 * the screen, the sizes and the checksums are what this fixture is for.
 */

/** `YYYYMMDDTHHMMSSZ`, the sortable half of an export id. */
function stamp(exportedAt: string): string {
  return exportedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** A stable eight-hex-digit suffix per instance, so the same instance always lists the same ids. */
function suffixFor(instanceId: string): string {
  let hash = 0;
  for (const char of instanceId) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash.toString(16).padStart(8, '0').slice(-8);
}

function digest(seed: string): string {
  return seed.repeat(Math.ceil(64 / seed.length)).slice(0, 64);
}

export function instanceExportsFor(instanceId: string): InstanceExport[] {
  const suffix = suffixFor(instanceId);
  const recent = hoursAgo(26);
  const older = hoursAgo(24 * 9);

  return [
    {
      exportId: `${stamp(recent)}-${suffix}`,
      exportedAt: recent,
      fileName: `${stamp(recent)}-${suffix}.tar.gz`,
      bytes: 734_003_200,
      sha256: digest(suffix),
      includes: ['database', 'volumes', 'definition', 'environment'],
      excluded: [
        {
          item: 'secrets',
          reason:
            'secret values are never exported; instance/env.json names every one so it can be supplied again',
        },
      ],
      renderSetId: `rs-${suffix}`,
    },
    {
      exportId: `${stamp(older)}-${suffix}`,
      exportedAt: older,
      fileName: `${stamp(older)}-${suffix}.tar.gz`,
      bytes: 612_368_384,
      sha256: digest(`${suffix.slice(0, 4)}ab`),
      includes: ['database', 'volumes', 'environment'],
      excluded: [
        {
          item: 'secrets',
          reason: 'secret values are never exported; theirs are named in instance/env.json',
        },
        {
          item: 'definition',
          reason:
            'the applied render set directory was no longer on disk when the archive was packed',
        },
      ],
      renderSetId: null,
    },
  ];
}

/** The body the mock serves for an archive download: a placeholder, with the real headers. */
export function exportArchiveBody(instanceId: string, exportId: string): string {
  return [
    `SEAMNEX EXPORT (prototype placeholder)`,
    `instance: ${instanceId}`,
    `export: ${exportId}`,
    'The API serves the real .tar.gz here; the mock serves this line instead.',
    '',
  ].join('\n');
}
