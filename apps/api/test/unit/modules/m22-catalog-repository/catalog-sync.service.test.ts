import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { AppConfig } from '../../../../src/config/config';
import { AppError } from '../../../../src/common/problem/app-error';
import { ExecError } from '../../../../src/common/exec/exec';
import { CatalogSyncServiceImpl } from '../../../../src/modules/m22-catalog-repository/catalog-sync.service';
import {
  SYNC_MARKER_NAME,
  readSyncMarker,
  writeSyncMarker,
} from '../../../../src/modules/m22-catalog-repository/catalog-sync.marker';

/**
 * ADR-BE-42 §10.2 — the eight rules, asserted one refusal at a time.
 *
 * The git boundary is mocked (a real clone would need a network and a tag) and the working tree is a
 * temporary directory, so each case is about the service's decision rather than about git's
 * behaviour. The acceptances that matter are negative ones: a rejected host must never reach git, a
 * failed fetch must leave the tree byte-identical, and a re-sync at the same commit must not rewrite
 * anything (AC-16, AC-17, AC-20, AC-24).
 */
const git = vi.hoisted(() => ({
  assertAllowedSourceUrl: vi.fn(),
  cloneAtRevision: vi.fn(),
  commitOf: vi.fn(),
  resolveRefKind: vi.fn(),
}));

vi.mock('../../../../src/common/exec/git', () => git);

const SHA = 'a'.repeat(40);
const REF = 'catalog-2026.11.0';

const trees: string[] = [];
let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'seamnex-catalog-sync-'));
  trees.push(root);

  git.assertAllowedSourceUrl.mockReturnValue(
    new URL('https://github.com/orbivort/seamnex-catalog'),
  );
  git.resolveRefKind.mockResolvedValue('tag');
  git.commitOf.mockResolvedValue(SHA);
  git.cloneAtRevision.mockImplementation(async (input: { targetDir: string }) => {
    writeCheckout(input.targetDir);
    return { commit: SHA, revision: REF };
  });
});

afterEach(() => {
  for (const directory of trees.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** What a successful fetch leaves in its staging directory. */
function writeCheckout(targetDir: string): void {
  mkdirSync(join(targetDir, 'catalog'), { recursive: true });
  writeFileSync(join(targetDir, 'catalog', 'D01-01.json'), '{}', 'utf8');
  mkdirSync(join(targetDir, 'upstream', 'D01-01'), { recursive: true });
  writeFileSync(join(targetDir, 'upstream', 'D01-01', 'compose.yml'), 'services: {}', 'utf8');
  mkdirSync(join(targetDir, '.git'), { recursive: true });
  writeFileSync(join(targetDir, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
  writeFileSync(join(targetDir, 'README.md'), '# catalogue', 'utf8');
}

function config(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    SEAMNEX_CATALOG_REPO_PATH: root,
    SEAMNEX_CATALOG_SOURCE_URL: 'https://github.com/orbivort/seamnex-catalog',
    SEAMNEX_CATALOG_SOURCE_REF: REF,
    SEAMNEX_CATALOG_SYNC_COOLDOWN_MS: 0,
    sourceAllowedHosts: ['github.com'],
    ...overrides,
  } as unknown as AppConfig;
}

function fakePool(
  input: { locked?: boolean; commits?: unknown[]; unlockFails?: boolean } = {},
): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: input.locked ?? true }] };
    if (sql.includes('pg_advisory_unlock')) {
      if (input.unlockFails === true) throw new Error('connection terminated');
      return { rows: [{ pg_advisory_unlock: true }] };
    }
    if (sql.includes('FROM catalog_commit')) return { rows: input.commits ?? [] };
    return { rows: [] };
  });
  return {
    query,
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
  } as unknown as Pool;
}

function service(
  overrides: Record<string, unknown> = {},
  pool: Pool = fakePool(),
): { service: CatalogSyncServiceImpl; recordCommit: ReturnType<typeof vi.fn> } {
  const recordCommit = vi.fn(async () => undefined);
  const repository = {
    load: vi.fn(),
    revision: vi.fn(async () => 'r1'),
    recordCommit,
  };
  const instance = new CatalogSyncServiceImpl(config(overrides), pool, repository as never);
  return { service: instance, recordCommit };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('expected the sync to be refused');
}

describe('catalog sync refusals', () => {
  it('refuses when no source is configured, without touching git', async () => {
    const { service: sync } = service({ SEAMNEX_CATALOG_SOURCE_URL: '' });

    expect(await refusal(sync.sync({ actorId: 'u1' }))).toBe('SOURCE_NOT_CONFIGURED');
    expect(git.cloneAtRevision).not.toHaveBeenCalled();
  });

  it('refuses when neither the request nor the configuration names a ref', async () => {
    const { service: sync } = service({ SEAMNEX_CATALOG_SOURCE_REF: '' });

    expect(await refusal(sync.sync({ actorId: 'u1' }))).toBe('SOURCE_REF_REQUIRED');
    expect(git.cloneAtRevision).not.toHaveBeenCalled();
  });

  it('refuses a branch spelled as a ref path', async () => {
    const { service: sync } = service();

    expect(await refusal(sync.sync({ ref: 'refs/heads/main', actorId: 'u1' }))).toBe(
      'SOURCE_REF_REJECTED',
    );
  });

  it('AC-16: refuses an unlisted host before any git call', async () => {
    git.assertAllowedSourceUrl.mockImplementation(() => {
      throw new Error('host not in SEAMNEX_SOURCE_ALLOWED_HOSTS');
    });
    const { service: sync } = service();

    expect(await refusal(sync.sync({ actorId: 'u1' }))).toBe('SOURCE_URL_REJECTED');
    // The guard runs before the lookup *and* before the clone: nothing reached the network.
    expect(git.resolveRefKind).not.toHaveBeenCalled();
    expect(git.cloneAtRevision).not.toHaveBeenCalled();
  });

  it('refuses a branch, naming it as a branch rather than as a missing tag', async () => {
    git.resolveRefKind.mockResolvedValue('branch');
    const { service: sync } = service();

    expect(await refusal(sync.sync({ ref: 'main', actorId: 'u1' }))).toBe('SOURCE_REF_IS_BRANCH');
    expect(git.cloneAtRevision).not.toHaveBeenCalled();
  });

  it('refuses a tag the source does not have', async () => {
    git.resolveRefKind.mockResolvedValue('missing');
    const { service: sync } = service();

    expect(await refusal(sync.sync({ actorId: 'u1' }))).toBe('SOURCE_REF_NOT_FOUND');
    expect(git.cloneAtRevision).not.toHaveBeenCalled();
  });

  it('AC-17: a failed fetch leaves the tree exactly as it was', async () => {
    git.cloneAtRevision.mockRejectedValue(new Error('fatal: could not read from remote'));
    const { service: sync, recordCommit } = service();

    expect(await refusal(sync.sync({ actorId: 'u1' }))).toBe('SOURCE_CLONE_FAILED');
    expect(existsSync(join(root, 'catalog'))).toBe(false);
    expect(readSyncMarker(root)).toBeNull();
    expect(recordCommit).not.toHaveBeenCalled();
    // The staging directory is removed even on failure: a crashed sync leaves no second tree.
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses a tag that carries no catalogue, before swapping anything in', async () => {
    git.cloneAtRevision.mockImplementation(async (input: { targetDir: string }) => {
      mkdirSync(join(input.targetDir, '.git'), { recursive: true });
      return { commit: SHA, revision: REF };
    });
    const { service: sync } = service();

    expect(await refusal(sync.sync({ actorId: 'u1' }))).toBe('SOURCE_EMPTY_TREE');
    expect(existsSync(join(root, 'catalog'))).toBe(false);
  });

  it('AC-24: refuses a root the platform cannot write to', async () => {
    const blocked = join(root, 'not-a-directory');
    writeFileSync(blocked, 'file, not a directory', 'utf8');
    const { service: sync } = service({
      SEAMNEX_CATALOG_REPO_PATH: join(blocked, 'catalog-repo'),
    });

    expect(await refusal(sync.sync({ actorId: 'u1' }))).toBe('SOURCE_ROOT_NOT_WRITABLE');
    expect(git.cloneAtRevision).not.toHaveBeenCalled();
  });

  it('refuses when another sync holds the advisory lock', async () => {
    const { service: sync } = service({}, fakePool({ locked: false }));

    expect(await refusal(sync.sync({ actorId: 'u1' }))).toBe('SOURCE_SYNC_IN_PROGRESS');
    expect(git.cloneAtRevision).not.toHaveBeenCalled();
  });

  it('reports the tail of the git output a failed clone left behind', async () => {
    git.cloneAtRevision.mockRejectedValue(
      new ExecError({
        file: 'git',
        args: ['fetch'],
        code: 128,
        stderr: 'warning: redirecting\nfatal: repository not found\n',
        message: 'git fetch exited with code 128',
      }),
    );
    const { service: sync } = service();

    try {
      await sync.sync({ actorId: 'u1' });
      expect.unreachable('the sync must be refused');
    } catch (error) {
      expect((error as AppError).code).toBe('SOURCE_CLONE_FAILED');
      // The reason git gave, not "the fetch failed": a support call starts from which of the two.
      expect((error as AppError).detail).toContain('fatal: repository not found');
    }
  });

  it('falls back to the error message when git wrote nothing to stderr', async () => {
    git.cloneAtRevision.mockRejectedValue(
      new ExecError({
        file: 'git',
        args: ['fetch'],
        code: 128,
        stderr: '  \n',
        message: 'git fetch exited with code 128',
      }),
    );
    const { service: sync } = service();

    try {
      await sync.sync({ actorId: 'u1' });
      expect.unreachable('the sync must be refused');
    } catch (error) {
      // The prefix is still there, so the refusal names the step even when git said nothing.
      expect((error as AppError).detail).toMatch(/^The catalogue source could not be fetched:/);
    }
  });

  it('refuses in a named way when the source cannot even be resolved', async () => {
    // A non-Error rejection is what a raw thrown string looks like; the detail must still read.
    git.resolveRefKind.mockRejectedValue('connection reset');

    const { service: sync } = service();

    try {
      await sync.sync({ actorId: 'u1' });
      expect.unreachable('the sync must be refused');
    } catch (error) {
      expect((error as AppError).code).toBe('SOURCE_CLONE_FAILED');
      expect((error as AppError).detail).toContain('connection reset');
    }
  });

  it('refuses a second sync from the same operator inside the cooldown', async () => {
    const { service: sync } = service({ SEAMNEX_CATALOG_SYNC_COOLDOWN_MS: 600_000 });

    await sync.sync({ actorId: 'u1' });
    expect(await refusal(sync.sync({ actorId: 'u1' }))).toBe('SOURCE_SYNC_COOLDOWN');
    // Another operator is not blocked by one person's cooldown.
    await expect(sync.sync({ actorId: 'u2' })).resolves.toMatchObject({ commit: SHA });
  });
});

describe('catalog sync success', () => {
  it('swaps the children in and records the commit before the caller reloads', async () => {
    const { service: sync, recordCommit } = service();

    const outcome = await sync.sync({ actorId: 'u1' });

    expect(outcome).toEqual({
      url: 'github.com/orbivort/seamnex-catalog',
      ref: REF,
      commit: SHA,
      staged: null,
    });
    expect(existsSync(join(root, 'catalog', 'D01-01.json'))).toBe(true);
    expect(existsSync(join(root, 'upstream', 'D01-01'))).toBe(true);
    expect(existsSync(join(root, 'README.md'))).toBe(true);
    // AC-19: the provenance row is written by the sync, so a projection that fails still names the
    // tree that produced it.
    expect(recordCommit).toHaveBeenCalledWith({
      sha: SHA,
      kind: 'metadata',
      actor: 'u1',
      message: `catalog sync ${REF} at ${SHA}`,
    });
    expect(readSyncMarker(root)).toBeNull();
  });

  it('AC-20: a re-sync at the commit already checked out changes nothing', async () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'catalog'), { recursive: true });
    writeFileSync(join(root, 'catalog', 'D01-01.json'), '{"hand":"placed"}', 'utf8');
    git.commitOf.mockResolvedValue(SHA);

    const { service: sync } = service();
    const outcome = await sync.sync({ actorId: 'u1' });

    expect(outcome.staged).toBeNull();
    // The document is byte-identical: no swap ran, so a hand-applied tree is not overwritten.
    expect(existsSync(join(root, '.git', 'HEAD'))).toBe(false);
    expect(existsSync(join(root, 'README.md'))).toBe(false);
  });

  it('syncs even when the current head cannot be read', async () => {
    // An unreadable `.git` (a differing host uid, a stripped object store) must not block a fetch:
    // the comparison is an optimisation, and the swap is the safe path either way.
    mkdirSync(join(root, '.git'), { recursive: true });
    git.commitOf.mockRejectedValue(new Error('fatal: detected dubious ownership'));

    const { service: sync } = service();

    await expect(sync.sync({ actorId: 'u1' })).resolves.toMatchObject({ commit: SHA });
    expect(existsSync(join(root, 'catalog', 'D01-01.json'))).toBe(true);
  });

  it('releases the advisory lock even when the unlock fails', async () => {
    // The lock is session-scoped, so a failed unlock is logged rather than turned into a failed sync:
    // the connection is released below, which drops it anyway.
    const { service: sync } = service({}, fakePool({ unlockFails: true }));

    await expect(sync.sync({ actorId: 'u1' })).resolves.toMatchObject({ commit: SHA });
  });

  it('AC-18: repairs a mixed tree even when the head already matches', async () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'catalog'), { recursive: true });
    // A marker means a previous swap stopped between renames; a short-circuit would strand it.
    writeSyncMarker(root, {
      ref: REF,
      commit: SHA,
      actor: 'u0',
      startedAt: '2026-01-01T00:00:00.000Z',
      pending: ['upstream', '.git'],
    });
    git.commitOf.mockResolvedValue(SHA);

    const { service: sync } = service();
    const outcome = await sync.sync({ actorId: 'u1' });

    expect(outcome.staged).toBeNull();
    expect(existsSync(join(root, 'upstream', 'D01-01'))).toBe(true);
    expect(readSyncMarker(root)).toBeNull();
  });
});

describe('GET /catalog/repository read model', () => {
  it('reports the revision, the configured source, the last sync and a mixed tree', async () => {
    mkdirSync(join(root, 'catalog'), { recursive: true });
    writeSyncMarker(root, {
      ref: REF,
      commit: SHA,
      actor: 'u0',
      startedAt: '2026-01-01T00:00:00.000Z',
      pending: ['upstream'],
    });
    const pool = fakePool({
      commits: [
        {
          sha: SHA,
          actor: 'u0',
          message: `catalog sync ${REF} at ${SHA}`,
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });
    const { service: sync } = service({}, pool);

    const view = await sync.read();

    expect(view.revision).toBe('r1');
    expect(view.source).toEqual({
      configured: true,
      host: 'github.com/orbivort/seamnex-catalog',
      ref: REF,
    });
    expect(view.commit).toEqual({
      sha: SHA,
      actor: 'u0',
      message: `catalog sync ${REF} at ${SHA}`,
      recordedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(view.staged).toEqual({ pending: ['upstream'] });
    // The marker is a file under the root, not a second column: `GET` must not need a write.
    expect(existsSync(join(root, SYNC_MARKER_NAME))).toBe(true);
  });

  it('strips the git+ prefix a configured source may carry', async () => {
    // `.env` values are copied from `git clone` lines, which sometimes carry the prefix. The view
    // must show the host, not the prefix, or the operator reads a scheme as part of a hostname.
    const { service: sync } = service({
      SEAMNEX_CATALOG_SOURCE_URL: 'git+https://github.com/orbivort/seamnex-catalog.git',
    });

    await expect(sync.read()).resolves.toMatchObject({
      source: { configured: true, host: 'github.com/orbivort/seamnex-catalog' },
    });
  });

  it('reports a configured source it cannot parse as configured but unnamed', async () => {
    // A typo in `.env` must not blank the screen: the operator needs to see that a source *is* set,
    // and that it is unusable, which is what a sync will then refuse with a named code.
    const { service: sync } = service({ SEAMNEX_CATALOG_SOURCE_URL: 'not a url' });

    const view = await sync.read();

    expect(view.source).toEqual({ configured: true, host: null, ref: REF });
  });

  it('reports an unconfigured source as disabled rather than as an error', async () => {
    const { service: sync } = service({
      SEAMNEX_CATALOG_SOURCE_URL: '',
      SEAMNEX_CATALOG_SOURCE_REF: '',
    });

    const view = await sync.read();

    expect(view.source).toEqual({ configured: false, host: null, ref: null });
    expect(view.commit).toBeNull();
    expect(view.staged).toBeNull();
  });
});
