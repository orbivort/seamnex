import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The staging marker: what a swap was in the middle of doing (ADR-BE-42 §10.2 rule 8).
 *
 * A sync renames the tree's children one at a time because the root itself is a bind mount and
 * cannot be renamed. Those renames are sequentially consistent but not one transaction, so a failure
 * between them leaves a mixed tree — new `catalog/` against old `upstream/`, for example. Recording
 * the plan *before* the first rename, and the remaining steps before each subsequent one, is what
 * turns that state from an inference into a report: `GET /catalog/repository` serves it and the next
 * sync at the same ref repairs it.
 *
 * The marker lives at the root rather than inside a child, because every child is replaced and the
 * marker has to survive the replacement it describes.
 */
export const SYNC_MARKER_NAME = '.sync-marker.json';

export type SyncMarker = {
  readonly ref: string;
  readonly commit: string;
  readonly actor: string;
  readonly startedAt: string;
  /** Children whose rename has not run yet, in the order the swap would apply them. */
  readonly pending: readonly string[];
};

export function markerPath(root: string): string {
  return join(root, SYNC_MARKER_NAME);
}

/**
 * The marker, or `null` when there is none or it cannot be read.
 *
 * A corrupt marker is not a refusal: the tree is still the tree, and refusing to report it would
 * make a broken marker indistinguishable from a broken catalogue. The read model shows nothing and
 * the next sync overwrites it.
 */
export function readSyncMarker(root: string): SyncMarker | null {
  const path = markerPath(root);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const marker = parsed as Partial<SyncMarker>;
    if (
      typeof marker.ref !== 'string' ||
      typeof marker.commit !== 'string' ||
      typeof marker.actor !== 'string' ||
      typeof marker.startedAt !== 'string' ||
      !Array.isArray(marker.pending) ||
      marker.pending.some((entry) => typeof entry !== 'string')
    ) {
      return null;
    }
    return {
      ref: marker.ref,
      commit: marker.commit,
      actor: marker.actor,
      startedAt: marker.startedAt,
      pending: marker.pending as readonly string[],
    };
  } catch {
    return null;
  }
}

export function writeSyncMarker(root: string, marker: SyncMarker): void {
  writeFileSync(markerPath(root), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

/** An empty pending list means the swap completed, so the marker's job is done. */
export function clearSyncMarker(root: string): void {
  rmSync(markerPath(root), { force: true });
}
