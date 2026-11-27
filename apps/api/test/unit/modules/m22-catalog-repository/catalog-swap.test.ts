import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applySwap,
  planSwap,
  type SwapIo,
} from '../../../../src/modules/m22-catalog-repository/catalog-swap';

/**
 * ADR-BE-42 §10.2 rules 2 and 8 — what the swap promises, and what it refuses to pretend.
 *
 * Two properties are load-bearing and neither is observable from a passing sync: the root is never
 * renamed (it is a bind mount), and a rename that fails halfway leaves a recorded order rather than a
 * tree nobody can explain. The filesystem is injected so AC-18 can fail the second rename on any
 * platform — a permission change is not arrangeable on Windows.
 */
const trees: string[] = [];

function tree(): { root: string; stage: string } {
  const base = mkdtempSync(join(tmpdir(), 'seamnex-catalog-swap-'));
  trees.push(base);
  const root = join(base, 'root');
  const stage = join(base, 'stage');
  mkdirSync(root, { recursive: true });
  return { root, stage };
}

function writeStage(stage: string, children: readonly string[]): void {
  for (const child of children) {
    mkdirSync(join(stage, child), { recursive: true });
    writeFileSync(join(stage, child, 'marker'), child, 'utf8');
  }
}

function memoryIo(failOn?: string): { io: SwapIo; pending: string[][] } {
  const pending: string[][] = [];
  const io: SwapIo = {
    exists: () => false,
    remove: () => undefined,
    move: (_from, to) => {
      if (failOn !== undefined && to.endsWith(failOn)) throw new Error(`EBUSY: ${to}`);
    },
    recordPending: (names) => pending.push([...names]),
  };
  return { io, pending };
}

afterEach(() => {
  for (const base of trees.splice(0)) rmSync(base, { recursive: true, force: true });
});

describe('planSwap', () => {
  it('swaps the three children first, then the documents in a stable order', () => {
    const { root, stage } = tree();
    writeStage(stage, ['catalog', 'upstream', '.git']);
    writeFileSync(join(stage, 'README.md'), 'readme', 'utf8');
    writeFileSync(join(stage, 'LICENSE'), 'licence', 'utf8');
    writeFileSync(join(stage, '.gitignore'), 'ignored', 'utf8');

    const steps = planSwap({ root, stage });

    // `.git` is swapped because the revision label is `git rev-parse HEAD` of the root: leaving it
    // behind would make the label describe the previous content for one catalogue generation.
    expect(steps.map((step) => step.name)).toEqual([
      'catalog',
      'upstream',
      '.git',
      'LICENSE',
      'README.md',
    ]);
    // Every target is a child of the root; the root itself is never a step.
    expect(steps.every((step) => step.to.startsWith(root))).toBe(true);
    expect(steps.some((step) => step.to === root)).toBe(false);
  });

  it('omits a child the tag does not carry', () => {
    const { root, stage } = tree();
    writeStage(stage, ['catalog']);

    expect(planSwap({ root, stage }).map((step) => step.name)).toEqual(['catalog']);
  });
});

describe('applySwap', () => {
  it('reports nothing pending when every step ran', () => {
    const { root, stage } = tree();
    writeStage(stage, ['catalog', 'upstream', '.git']);

    const { io, pending } = memoryIo();
    const result = applySwap(planSwap({ root, stage }), io);

    expect(result).toEqual([]);
    // The marker is written before each step and cleared at the end, so a crash is never invisible.
    expect(pending).toEqual([['catalog', 'upstream', '.git'], ['upstream', '.git'], ['.git'], []]);
  });

  it('AC-18: leaves the pending order recorded when a rename fails halfway', () => {
    const { root, stage } = tree();
    writeStage(stage, ['catalog', 'upstream', '.git']);

    const { io, pending } = memoryIo('upstream');

    expect(() => applySwap(planSwap({ root, stage }), io)).toThrow(/EBUSY/);
    // The failing step is still pending: `catalog` moved, `upstream` and `.git` did not.
    expect(pending.at(-1)).toEqual(['upstream', '.git']);
  });

  it('keeps the original failure when the marker cannot be written either', () => {
    const { root, stage } = tree();
    writeStage(stage, ['catalog', 'upstream']);
    let recorded = 0;
    const io: SwapIo = {
      exists: () => false,
      remove: () => undefined,
      move: () => {
        throw new Error('EXDEV: cross-device link');
      },
      recordPending: () => {
        // The first write succeeds; the one on the failure path does not.
        recorded += 1;
        if (recorded > 1) throw new Error('EROFS: read-only file system');
      },
    };

    // A marker that cannot be written must not replace the failure that caused it.
    expect(() => applySwap(planSwap({ root, stage }), io)).toThrow(/EXDEV/);
  });
});
