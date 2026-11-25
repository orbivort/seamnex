import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SYNC_MARKER_NAME,
  clearSyncMarker,
  markerPath,
  readSyncMarker,
  writeSyncMarker,
} from '../../../../src/modules/m22-catalog-repository/catalog-sync.marker';

/**
 * The staging marker is the only record of a mixed tree (ADR-BE-42 §10.2 rule 8).
 *
 * It is read by `GET /catalog/repository` on every page load, so a marker it cannot parse must not
 * become an error on a screen: the honest answer is "no marker", because an unreadable file says
 * nothing about whether the tree is mixed. These cases pin that, and pin the shape the read model
 * depends on.
 */
const MARKER = {
  ref: 'catalog-2026.11.0',
  commit: 'a'.repeat(40),
  actor: 'marta.nowak',
  startedAt: '2026-11-25T10:00:00.000Z',
  pending: ['upstream', '.git'],
} as const;

const dirs: string[] = [];

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'seamnex-sync-marker-'));
  dirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('sync marker', () => {
  it('round-trips the plan, and clears to nothing', () => {
    const directory = root();

    writeSyncMarker(directory, { ...MARKER, pending: [...MARKER.pending] });
    expect(readSyncMarker(directory)).toEqual({ ...MARKER, pending: ['upstream', '.git'] });
    // Readable by a human looking at a host: the pending order is the point of the file.
    expect(readFileSync(markerPath(directory), 'utf8')).toContain('"pending"');

    clearSyncMarker(directory);
    expect(readSyncMarker(directory)).toBeNull();
  });

  it('answers no marker when there is none, without creating one', () => {
    const directory = root();

    expect(readSyncMarker(directory)).toBeNull();
    expect(markerPath(directory).endsWith(SYNC_MARKER_NAME)).toBe(true);
  });

  it.each([
    ['not json', '{ not json'],
    ['not an object', '[]'],
    ['a missing field', JSON.stringify({ ...MARKER, pending: undefined })],
    ['a non-string pending entry', JSON.stringify({ ...MARKER, pending: [1] })],
  ])('answers no marker for %s', (_label, content) => {
    const directory = root();
    writeFileSync(markerPath(directory), content, 'utf8');

    // A corrupt marker is not a refusal: the tree is still the tree. Reporting nothing is the
    // honest answer, and the next sync overwrites the file.
    expect(readSyncMarker(directory)).toBeNull();
  });

  it('tolerates an unreadable file', () => {
    const directory = root();
    // A directory where the marker belongs: reading it throws EISDIR, which must not escape either.
    mkdirSync(markerPath(directory), { recursive: true });

    expect(readSyncMarker(directory)).toBeNull();
  });
});
