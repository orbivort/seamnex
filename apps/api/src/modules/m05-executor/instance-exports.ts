import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstanceExport } from '@seamnex/domain';
import { AppError } from '../../common/problem/app-error';
import { ensureDir, safeJoin, writeFileAtomic } from '../../common/fs/files';

/**
 * FR-1.13 / AC-20 — the export artefacts an instance has on disk, and the one place that knows their
 * layout.
 *
 * The archive and its description are one unit: `<exports>/<exportId>.tar.gz` plus
 * `<exports>/<exportId>.json`. There is no table. A row would be a second source of truth that can
 * disagree with the filesystem (a row without a file, a file without a row), and an export takes no
 * part in restore verification — it exists to leave the platform, so the file *is* the record. If
 * exports ever need to be queried or pruned by policy, a table can be added without moving a byte of
 * the artefact.
 *
 * The manifest inside the archive is the same document minus `archive`, which can only be known
 * after the tar exists. Both carry the same `files[]` digests, so a recipient can verify either.
 */

export type ExportInclude = 'database' | 'volumes' | 'definition' | 'environment';

export type ExportManifest = {
  readonly version: 1;
  readonly exportId: string;
  readonly exportedAt: string;
  readonly instance: {
    readonly id: string;
    readonly slug: string;
    readonly entryKey: string;
    readonly state: string;
  };
  /**
   * `applied: false` means the copy is the newest render set, not the one that ran — the truth a
   * failed deployment leaves behind, and one a reader must not have to infer.
   */
  readonly renderSet: {
    readonly id: string;
    readonly contentHash: string;
    readonly applied: boolean;
  } | null;
  /** What was actually captured; computed from what was written, never from a literal. */
  readonly includes: readonly ExportInclude[];
  /** What was deliberately left out, and why. Empty is a real answer. */
  readonly excluded: readonly { readonly item: string; readonly reason: string }[];
  /** Every archived file with its digest; `manifest.json` itself is the only one absent. */
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  /** Sum of `files[].bytes`: the uncompressed size of what the archive holds. */
  readonly totalBytes: number;
};

export type ExportArchive = {
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
};

export type ExportRecord = ExportManifest & { readonly archive: ExportArchive };

/**
 * `YYYYMMDDTHHMMSSZ-<8 hex>`: sorts chronologically as text, is safe in a URL and a filename, and
 * carries no dot — so a reader can reject traversal before the path is ever joined. The random
 * suffix covers two exports of the same instance in the same second, which a parallel restore can
 * produce.
 */
const EXPORT_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

/** The list is bounded: a bounded recent-first page is a screen, an unbounded one is a leak. */
export const EXPORT_LIST_LIMIT = 50;

export function exportsDirectory(dataDir: string, instanceId: string): string {
  return join(dataDir, instanceId, 'exports');
}

export function newExportId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${randomBytes(4).toString('hex')}`;
}

/**
 * Validated before any path is built.
 *
 * The id arrives from the browser, so the check is on the value and not on the string that contains
 * it: a pattern with no dot and no slash cannot express `..`, and `safeJoin` below is the second
 * gate rather than the only one.
 */
export function assertExportId(value: string): string {
  if (!EXPORT_ID_PATTERN.test(value)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: `"${value}" is not an export id.`,
      fieldErrors: [
        {
          field: 'exportId',
          code: 'format',
          message: 'Expected an export id such as 20261116T103100Z-1a2b3c4d.',
        },
      ],
      remediation: 'Read the export list and use the id it reports; nothing was read.',
    });
  }
  return value;
}

export function archiveFileName(exportId: string): string {
  return `${exportId}.tar.gz`;
}

export function sidecarFileName(exportId: string): string {
  return `${exportId}.json`;
}

export function archivePath(dataDir: string, instanceId: string, exportId: string): string {
  return safeJoin(exportsDirectory(dataDir, instanceId), archiveFileName(assertExportId(exportId)));
}

/** Writes the sidecar atomically: a reader never sees a half-written record it could act on. */
export function writeExportRecord(directory: string, record: ExportRecord): void {
  ensureDir(directory);
  writeFileAtomic(
    safeJoin(directory, sidecarFileName(record.exportId)),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/**
 * The exports of one instance, newest first.
 *
 * A sidecar that cannot be read is skipped and named through `onSkip` rather than failing the
 * screen: one interrupted write must not hide nineteen good archives. A cap keeps the read bounded
 * even if a host accumulates thousands of them.
 */
export async function listExportRecords(
  directory: string,
  options: {
    readonly limit?: number;
    readonly onSkip?: (fileName: string, reason: string) => void;
  } = {},
): Promise<ExportRecord[]> {
  const limit = options.limit ?? EXPORT_LIST_LIMIT;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const ids = entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => EXPORT_ID_PATTERN.test(id))
    .sort((left, right) => right.localeCompare(left))
    .slice(0, limit);

  const records: ExportRecord[] = [];
  for (const exportId of ids) {
    const record = await readRecord(directory, exportId);
    if (record === null) {
      options.onSkip?.(sidecarFileName(exportId), 'the sidecar is unreadable or incomplete');
      continue;
    }
    records.push(record);
  }
  return records;
}

export async function readExportRecord(
  directory: string,
  exportId: string,
): Promise<ExportRecord | null> {
  return readRecord(directory, assertExportId(exportId));
}

/**
 * The API projection, in one place so the contract and the sidecar cannot drift.
 *
 * The browser never sees the archive path: it receives an id and a filename, and asks for the
 * archive through a route that resolves the path itself from that id.
 */
export function toInstanceExport(record: ExportRecord): InstanceExport {
  return {
    exportId: record.exportId,
    exportedAt: record.exportedAt,
    fileName: record.archive.fileName,
    bytes: record.archive.bytes,
    sha256: record.archive.sha256,
    includes: [...record.includes],
    excluded: record.excluded.map((entry) => ({ item: entry.item, reason: entry.reason })),
    renderSetId: record.renderSet?.id ?? null,
  };
}

async function readRecord(directory: string, exportId: string): Promise<ExportRecord | null> {
  let text: string;
  try {
    text = await readFile(safeJoin(directory, sidecarFileName(exportId)), 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    return parseRecord(JSON.parse(text) as unknown, exportId);
  } catch {
    return null;
  }
}

/**
 * The one definition of a valid sidecar.
 *
 * Written as a guard rather than a zod schema because this document is internal — the browser reads
 * the API projection, which `packages/domain` validates. What matters here is that a truncated file
 * is rejected instead of being rendered as an export with missing fields.
 */
function parseRecord(value: unknown, exportId: string): ExportRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<ExportRecord>;
  if (record.version !== 1 || record.exportId !== exportId) return null;
  if (typeof record.exportedAt !== 'string') return null;
  if (typeof record.instance?.id !== 'string' || typeof record.instance?.slug !== 'string')
    return null;
  if (!Array.isArray(record.includes) || !Array.isArray(record.excluded)) return null;
  if (!Array.isArray(record.files) || typeof record.totalBytes !== 'number') return null;
  const archive = record.archive;
  if (
    archive === undefined ||
    typeof archive.fileName !== 'string' ||
    typeof archive.bytes !== 'number' ||
    typeof archive.sha256 !== 'string'
  ) {
    return null;
  }
  return record as ExportRecord;
}

function isMissing(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ENOENT';
}
