import { join } from 'node:path';

/**
 * Where a render set's files live on disk: `…/<instance>/render/<renderSetId>`.
 *
 * Two code paths write these files — the renderer, when it materialises a set, and the restore, when
 * it brings a stored set back on a host that never deployed the instance — and `compose up` needs the
 * same directory from both. Computed in one place so a change to the layout cannot leave the restore
 * composing from yesterday's path, which fails as "no such file" in the middle of a disaster.
 */
export function renderSetDirectory(
  dataDir: string,
  instanceId: string,
  renderSetId: string,
): string {
  return join(dataDir, instanceId, 'render', renderSetId);
}
