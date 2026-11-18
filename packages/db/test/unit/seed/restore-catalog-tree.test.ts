import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PRODUCT_KEYS } from '../../../src/seed/default-catalog';
import { decideTreeRestore } from '../../../src/seed/restore-catalog-tree';

/**
 * The recovery step for `no catalogue working tree … while N catalog entries are projected`.
 *
 * The command is a script, like `dev-seed.ts`: it reads the environment, asks the database which
 * entries are projected, decides, writes and exits. Its collaborators (`createPool`, `loadRootEnv`)
 * are doubled and the module is imported per case, so the exit codes and the refusal cases are
 * tested without a database — and, just as important, without writing into the repository's own
 * `temp/catalog-repo`, which would be indistinguishable from an operator's tree.
 */
const doubles = vi.hoisted(() => ({
  createPool: vi.fn(),
  loadRootEnv: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));

vi.mock('../../../src/client', () => ({ createPool: doubles.createPool }));
/*
 * Only the `.env` load is doubled: `REPOSITORY_ROOT` is the path constant the default set resolves
 * its vendored documents against, and stubbing it would let the suite "find" fixtures wherever the
 * double said.
 */
vi.mock('../../../src/env', async (importOriginal) => ({
  ...(await importOriginal()),
  loadRootEnv: doubles.loadRootEnv,
}));

const CONNECTION = 'postgres://seamnex:seamnex@localhost:5432/seamnex';
const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  SEAMNEX_CATALOG_REPO_PATH: process.env.SEAMNEX_CATALOG_REPO_PATH,
};

const trees: string[] = [];
let currentTree = '';

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  doubles.createPool.mockReturnValue({ query: doubles.query, end: doubles.end });
  doubles.query.mockResolvedValue({ rows: DEFAULT_PRODUCT_KEYS.map((key) => ({ key })) });
  doubles.end.mockResolvedValue(undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const directory of trees.splice(0)) rmSync(directory, { recursive: true, force: true });
  process.exitCode = undefined;
});

async function runRestore(
  env: Record<string, string | undefined>,
  /** Runs against the fresh tree before the command reads it, for the "tree already there" cases. */
  prepare?: (tree: string) => void,
): Promise<number | undefined> {
  const previousExitCode = process.exitCode;
  currentTree = mkdtempSync(join(tmpdir(), 'seamnex-catalog-restore-'));
  trees.push(currentTree);
  prepare?.(currentTree);
  for (const [key, value] of Object.entries({
    ...env,
    SEAMNEX_CATALOG_REPO_PATH: currentTree,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.exitCode = undefined;

  vi.resetModules();
  try {
    await import('../../../src/seed/restore-catalog-tree');
    await vi.waitFor(() => {
      expect(process.exitCode).toBeDefined();
    });
    return process.exitCode;
  } finally {
    process.exitCode = previousExitCode;
  }
}

/** Every message the run printed, in order. */
function printed(): string {
  return logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
}

describe('decideTreeRestore', () => {
  const ROOT = '/srv/seamnex/temp/catalog-repo';

  it('restores only a projection that is exactly the default set', () => {
    const decision = decideTreeRestore({
      root: ROOT,
      catalogPresent: false,
      projectedKeys: [...DEFAULT_PRODUCT_KEYS],
    });

    expect(decision.restore).toBe(true);
    expect(decision.code).toBe(0);
    expect(decision.lines[0]).toContain('exactly the default set');
  });

  it('refuses an operator catalogue, naming both halves of the mismatch', () => {
    // One default key removed and one key no vendored document declares: the rows came from a tree
    // this repository cannot reproduce, so writing the default set beside them would declare six
    // products the operator never had.
    const decision = decideTreeRestore({
      root: ROOT,
      catalogPresent: false,
      projectedKeys: [...DEFAULT_PRODUCT_KEYS.slice(1), 'D99-99'],
    });

    expect(decision.restore).toBe(false);
    expect(decision.code).toBe(1);
    expect(decision.lines.join('\n')).toContain('D01-01');
    expect(decision.lines.join('\n')).toContain('D99-99');
    expect(decision.lines.join('\n')).toContain('cannot reproduce');
  });

  it('leaves a present tree alone, and an empty projection to the seed', () => {
    const present = decideTreeRestore({ root: ROOT, catalogPresent: true, projectedKeys: [] });
    const empty = decideTreeRestore({ root: ROOT, catalogPresent: false, projectedKeys: [] });

    expect([present.restore, present.code]).toEqual([false, 0]);
    expect([empty.restore, empty.code]).toEqual([false, 0]);
    expect(empty.lines.join('\n')).toContain('pnpm db:seed');
  });
});

describe('catalog:restore', () => {
  it('writes both halves of the default set back into a tree that is gone', async () => {
    const code = await runRestore({ DATABASE_URL: CONNECTION });

    expect(code).toBe(0);
    // The exact state `pnpm dev` stopped in: six rows, no `catalog/`. Both halves come back — the
    // documents a reload reconciles against and the declarations the projection applies.
    const documents = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    expect(documents(join(currentTree, 'catalog'))).toEqual(
      DEFAULT_PRODUCT_KEYS.map((key) => `${key}.json`).sort(),
    );
    expect(documents(join(currentTree, 'catalog', 'env'))).toEqual(
      DEFAULT_PRODUCT_KEYS.map((key) => `${key}.json`).sort(),
    );
    expect(printed()).toContain('12 of 12 file(s) written');
    // The declarations are files at this point; the projection is the next step, not this one.
    expect(printed()).toContain('pnpm catalog:project');
    expect(doubles.createPool).toHaveBeenCalledWith({
      connectionString: CONNECTION,
      max: 1,
      applicationName: 'seamnex-catalog-restore',
    });
    expect(doubles.end).toHaveBeenCalledTimes(1);
  });

  it('refuses, writes nothing and names the keys when the projection is not the default set', async () => {
    doubles.query.mockResolvedValue({ rows: [{ key: 'D01-01' }, { key: 'D99-99' }] });

    const code = await runRestore({ DATABASE_URL: CONNECTION });

    expect(code).toBe(1);
    expect(existsSync(join(currentTree, 'catalog'))).toBe(false);
    expect(printed()).toContain('not the default set');
    expect(printed()).toContain('D99-99');
    expect(doubles.end).toHaveBeenCalledTimes(1);
  });

  it('never touches a tree that is present, even with a default-set projection', async () => {
    const code = await runRestore({ DATABASE_URL: CONNECTION }, (tree) => {
      mkdirSync(join(tree, 'catalog'), { recursive: true });
      writeFileSync(join(tree, 'catalog', 'D01-01.json'), '{"key":"D01-01"}', 'utf8');
    });

    expect(code).toBe(0);
    expect(readdirSync(join(currentTree, 'catalog'))).toEqual(['D01-01.json']);
    expect(printed()).toContain('is present');
  });

  it('leaves an empty projection to the seed', async () => {
    doubles.query.mockResolvedValue({ rows: [] });

    const code = await runRestore({ DATABASE_URL: CONNECTION });

    expect(code).toBe(0);
    expect(existsSync(join(currentTree, 'catalog'))).toBe(false);
    expect(printed()).toContain('pnpm db:seed');
  });

  it('refuses to start without DATABASE_URL', async () => {
    const code = await runRestore({ DATABASE_URL: undefined });

    expect(code).toBe(1);
    expect(doubles.createPool).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]?.[0]).toContain('DATABASE_URL is required');
  });

  it('reports a failing read as one actionable line instead of throwing', async () => {
    doubles.query.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));

    const code = await runRestore({ DATABASE_URL: CONNECTION });

    expect(code).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe('[catalog] connect ECONNREFUSED 127.0.0.1:5432');
    // The pool is closed on the failure path too, or the process hangs for its idle timeout.
    expect(doubles.end).toHaveBeenCalledTimes(1);
  });
});
