import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The child swap, as a plan and an executor (ADR-BE-42 §10.2 rule 2).
 *
 * Three facts decide this shape:
 *
 *   1. **The root is never renamed.** It is a bind mount, so renaming it from inside fails with
 *      `EBUSY`, and renaming it on the host leaves a running container mounted on the detached inode
 *      and serving the previous catalogue. Only the children move.
 *   2. **`catalog/env` is not a child.** Declarations live under `catalog/`, so renaming `catalog`
 *      carries them. The design lists it separately; the tree does not, and inventing a second
 *      rename for a directory that is already gone would fail on every install.
 *   3. **The swap is not one transaction.** Four renames plus the documents are sequentially
 *      consistent, not atomic. `applySwap` reports what it had not done when a rename failed, so the
 *      caller can record a mixed tree instead of claiming a success the filesystem did not provide.
 */

/**
 * The directories replaced in this order, before any document.
 *
 * `.git` is part of the swap on purpose: the revision label is `git rev-parse HEAD` of the root, so
 * omitting it would make the label describe the previous content for one catalogue generation.
 */
const DIRECTORY_CHILDREN = ['catalog', 'upstream', '.git'] as const;

export type SwapStep = {
  /** The name the read model reports: `catalog`, `upstream`, `.git`, or a document's filename. */
  readonly name: string;
  readonly from: string;
  readonly to: string;
};

/**
 * What a swap would do, given a staged clone and the root it belongs in.
 *
 * Top-level documents are swapped because the tree is the checkout: `LICENSE`, `PROVENANCE.md` and
 * the notices describe the content beside them, so a tag that refreshes content without its own
 * documents would leave the root describing the previous tag. Dot-entries other than `.git` are
 * skipped — `.github` and `.gitignore` are repository metadata the loader never reads.
 */
export function planSwap(input: {
  readonly root: string;
  readonly stage: string;
}): readonly SwapStep[] {
  const steps: SwapStep[] = [];

  for (const name of DIRECTORY_CHILDREN) {
    const from = join(input.stage, name);
    if (existsSync(from)) steps.push({ name, from, to: join(input.root, name) });
  }

  const documents = readdirSync(input.stage, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  for (const name of documents) {
    steps.push({ name, from: join(input.stage, name), to: join(input.root, name) });
  }

  return steps;
}

/**
 * The filesystem, injected so a test can fail the second rename (AC-18) without a real permission
 * change — which no Windows host can arrange reliably.
 */
export type SwapIo = {
  readonly exists: (path: string) => boolean;
  readonly remove: (path: string) => void;
  readonly move: (from: string, to: string) => void;
  /** Recorded before every step, with everything still to do — including the step about to run. */
  readonly recordPending: (pending: readonly string[]) => void;
};

export const REAL_SWAP_IO: Omit<SwapIo, 'recordPending'> = {
  exists: (path) => existsSync(path),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  move: (from, to) => renameSync(from, to),
};

/**
 * Applies the plan and returns what did **not** happen.
 *
 * An empty result means every step ran. A non-empty one names the steps still holding their previous
 * content, which is the file the read model reports as `staged.pending`.
 */
export function applySwap(steps: readonly SwapStep[], io: SwapIo): readonly string[] {
  /*
   * `index` is the step about to run, so a throw leaves it pointing at the one that failed — which is
   * exactly the set the marker has to name. It is only advanced after a rename succeeded.
   */
  let index = 0;
  try {
    for (const step of steps) {
      io.recordPending(remaining(steps, index));
      if (io.exists(step.to)) io.remove(step.to);
      io.move(step.from, step.to);
      index += 1;
    }
    io.recordPending([]);
    return [];
  } catch (error) {
    // The marker is the only record of a mixed tree, so it is written before the failure propagates.
    try {
      io.recordPending(remaining(steps, index));
    } catch {
      // A marker that cannot be written must not replace the failure that caused it.
    }
    throw error;
  }
}

function remaining(steps: readonly SwapStep[], from: number): readonly string[] {
  return steps.slice(from).map((step) => step.name);
}
