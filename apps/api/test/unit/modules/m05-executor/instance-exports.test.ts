import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archivePath,
  assertExportId,
  exportsDirectory,
  listExportRecords,
  newExportId,
  readExportRecord,
  toInstanceExport,
  writeExportRecord,
  type ExportRecord,
} from '../../../../src/modules/m05-executor/instance-exports';

/**
 * FR-1.13 / AC-20 — the on-disk catalogue.
 *
 * This is the only reader of the export directory, so it is where "an id from the browser cannot
 * name a path", "a corrupt sidecar does not fail the screen" and "the projection the API returns
 * matches the artefact" are pinned.
 */
const ROOT = join('temp', 'm05-exports-tests');
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const VALID_ID = '20261116T103100Z-1a2b3c4d';

function record(exportId: string, overrides: Partial<ExportRecord> = {}): ExportRecord {
  return {
    version: 1,
    exportId,
    exportedAt: '2026-11-16T10:31:00.000Z',
    instance: { id: INSTANCE_ID, slug: 'crm', entryKey: 'D01-01', state: 'ready' },
    renderSet: { id: 'rs-000000000001', contentHash: 'hash-1', applied: true },
    includes: ['database', 'volumes'],
    excluded: [{ item: 'secrets', reason: 'never exported' }],
    files: [{ path: 'database/db.sql', sha256: 'b'.repeat(64), bytes: 12 }],
    totalBytes: 12,
    archive: { fileName: `${exportId}.tar.gz`, bytes: 34, sha256: 'c'.repeat(64) },
    ...overrides,
  };
}

let directory: string;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  directory = exportsDirectory(ROOT, INSTANCE_ID);
  mkdirSync(directory, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('export ids', () => {
  it('mints an id that is sortable, filename-safe and free of dots', () => {
    const id = newExportId(new Date('2026-11-16T10:31:00.123Z'));

    expect(id).toMatch(/^20261116T103100Z-[0-9a-f]{8}$/);
    expect(assertExportId(id)).toBe(id);
  });

  it('rejects anything that could express a path', () => {
    for (const id of ['..', '../etc/passwd', '20261116T103100Z-1a2b3c4d/../x', 'export.json']) {
      expect(() => assertExportId(id)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    }
  });

  it('resolves the archive inside the instance directory and nowhere else', () => {
    expect(archivePath(ROOT, INSTANCE_ID, VALID_ID)).toBe(resolve(directory, `${VALID_ID}.tar.gz`));
    expect(() => archivePath(ROOT, INSTANCE_ID, '../../escape')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});

describe('listExportRecords', () => {
  it('reads newest first and ignores everything that is not a sidecar', async () => {
    writeExportRecord(directory, record('20261109T103100Z-1a2b3c4d'));
    writeExportRecord(directory, record(VALID_ID));
    // Staging leftovers and the archives themselves are not records.
    mkdirSync(join(directory, '.staging-20261116T103100Z-1a2b3c4d'), { recursive: true });
    writeFileSync(join(directory, `${VALID_ID}.tar.gz`), 'bytes');
    writeFileSync(join(directory, 'notes.txt'), 'hello');

    const records = await listExportRecords(directory);

    expect(records.map((entry) => entry.exportId)).toEqual([VALID_ID, '20261109T103100Z-1a2b3c4d']);
  });

  it('skips a corrupt sidecar and names it instead of failing the whole list', async () => {
    writeExportRecord(directory, record(VALID_ID));
    writeFileSync(join(directory, '20261110T103100Z-deadbeef.json'), '{"version":1,"exp');
    // A record whose archive block is missing is as useless as a truncated file.
    writeFileSync(
      join(directory, '20261111T103100Z-deadbeef.json'),
      JSON.stringify({ version: 1 }),
    );
    const onSkip = vi.fn();

    const records = await listExportRecords(directory, { onSkip });

    expect(records.map((entry) => entry.exportId)).toEqual([VALID_ID]);
    expect(onSkip).toHaveBeenCalledTimes(2);
    expect(onSkip).toHaveBeenCalledWith(
      '20261110T103100Z-deadbeef.json',
      expect.stringContaining('unreadable'),
    );
  });

  it('answers an empty list for an instance that never exported', async () => {
    await expect(listExportRecords(join(ROOT, 'missing-instance'))).resolves.toEqual([]);
  });

  it('caps the page so a host that accumulates archives cannot unboundedly fill a screen', async () => {
    for (const day of ['01', '02', '03']) {
      writeExportRecord(directory, record(`202611${day}T103100Z-1a2b3c4d`));
    }

    const records = await listExportRecords(directory, { limit: 2 });

    expect(records.map((entry) => entry.exportId)).toEqual([
      '20261103T103100Z-1a2b3c4d',
      '20261102T103100Z-1a2b3c4d',
    ]);
  });

  it('surfaces an unknown filesystem failure rather than reporting no exports', async () => {
    // A path that is a file, not a directory: `ENOTDIR`, not the `ENOENT` of a never-exported
    // instance. Reporting an empty list here would hide a misconfigured data directory.
    const asFile = join(ROOT, 'not-a-directory');
    writeFileSync(asFile, 'x');

    await expect(listExportRecords(asFile)).rejects.toBeInstanceOf(Error);
  });

  it('surfaces a sidecar that exists but cannot be read', async () => {
    // A directory named like a sidecar: present in `readdir`, but `readFile` answers `EISDIR`.
    mkdirSync(join(directory, '20261112T103100Z-deadbeef.json'));

    await expect(listExportRecords(directory)).rejects.toBeInstanceOf(Error);
  });
});

describe('readExportRecord', () => {
  it('returns the record that was written, unrounded', async () => {
    writeExportRecord(directory, record(VALID_ID));

    await expect(readExportRecord(directory, VALID_ID)).resolves.toMatchObject({
      exportId: VALID_ID,
      includes: ['database', 'volumes'],
      archive: { bytes: 34 },
    });
  });

  it('answers null for an id that is well-formed but unknown', async () => {
    await expect(readExportRecord(directory, '20200101T000000Z-00000000')).resolves.toBeNull();
  });

  it('refuses a malformed id before touching the filesystem', async () => {
    await expect(readExportRecord(directory, '../../../etc/passwd')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  /**
   * A sidecar is written by a capture that can be interrupted, so a truncated or hand-edited file
   * must read as "no record" — every field the reader relies on is checked, one at a time.
   */
  it.each([
    ['a document that is not an object', '"text"'],
    ['a document with no version', JSON.stringify({ exportId: VALID_ID })],
    [
      'a document with no export time',
      JSON.stringify({ version: 1, exportId: VALID_ID, exportedAt: null }),
    ],
    [
      'a document with no instance',
      JSON.stringify({ version: 1, exportId: VALID_ID, exportedAt: 'now' }),
    ],
    [
      'a document with no include list',
      JSON.stringify({
        version: 1,
        exportId: VALID_ID,
        exportedAt: 'now',
        instance: { id: INSTANCE_ID, slug: 'crm' },
      }),
    ],
    [
      'a document with no file list',
      JSON.stringify({
        version: 1,
        exportId: VALID_ID,
        exportedAt: 'now',
        instance: { id: INSTANCE_ID, slug: 'crm' },
        includes: [],
        excluded: [],
      }),
    ],
    [
      'a document with no archive block',
      JSON.stringify({
        version: 1,
        exportId: VALID_ID,
        exportedAt: 'now',
        instance: { id: INSTANCE_ID, slug: 'crm' },
        includes: [],
        excluded: [],
        files: [],
        totalBytes: 0,
      }),
    ],
  ])('answers null for %s', async (_label, body) => {
    writeFileSync(join(directory, `${VALID_ID}.json`), body);

    await expect(readExportRecord(directory, VALID_ID)).resolves.toBeNull();
  });
});

describe('toInstanceExport', () => {
  it('projects the artefact without leaking its path', () => {
    expect(toInstanceExport(record(VALID_ID))).toEqual({
      exportId: VALID_ID,
      exportedAt: '2026-11-16T10:31:00.000Z',
      fileName: `${VALID_ID}.tar.gz`,
      bytes: 34,
      sha256: 'c'.repeat(64),
      includes: ['database', 'volumes'],
      excluded: [{ item: 'secrets', reason: 'never exported' }],
      renderSetId: 'rs-000000000001',
    });
  });

  it('reports no render set for an archive whose definition was already gone', () => {
    expect(toInstanceExport(record(VALID_ID, { renderSet: null })).renderSetId).toBeNull();
  });
});
