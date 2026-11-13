import type * as NodeFs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { WorkingTreeCatalogRepository } from '../../../../src/modules/m22-catalog-repository/catalog-repo.service';

/**
 * The working-tree loader is the only place a hand-written artefact becomes platform data. The two
 * properties that matter: a malformed file is reported as `invalid` (never as a deletion, and never
 * as a 500 at read time), and the revision changes when *either* artefact kind changes — otherwise
 * an environment-only edit would look like no change at all.
 */
const h = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: h.execFileSync }));
// Delegating `readFileSync` to the real implementation keeps every other test honest while letting
// one case throw something that is not an `Error` — which is what a broken FUSE mount looks like.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const TIMESTAMP = '2026-01-01T00:00:00.000Z';

const ENTRY = {
  key: 'D01-01',
  domain: 'collaboration',
  cluster: 'Core Operations',
  product: 'EspoCRM',
  description: 'CRM and customer records',
  repoUrl: 'https://example.test/espocrm',
  licenseId: 'AGPL-3.0',
  stack: 'php',
  imageRef: 'espocrm/espocrm:8.0.0',
  imageDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  upstream: {
    currentVersion: '8.0.0',
    latestVersion: '8.0.0',
    advisory: null,
    releaseUrl: 'https://example.test/releases',
    checkedAt: TIMESTAMP,
  },
  guaranteeClass: 'native',
  authMethod: 'oidc',
  packaging: 'compose',
  packagingSource: 'upstream',
  primaryInstanceId: null,
  sharedWith: [],
  httpPort: 80,
  resources: { cpu: 1, memoryMb: 512, diskMb: 1024 },
  dependencies: [],
  volumes: [],
  integration: {
    apiBaseUrl: 'https://crm.example.test/api',
    authMethod: 'oidc',
    guaranteeClassVerified: 'native',
    operationInventory: [],
    eventModes: [],
    credentialGranularity: 'scoped',
    sessionMaxMinutes: 60,
    sloSupported: true,
    verifiedBy: 'alice',
    verifiedAt: TIMESTAMP,
    nextReviewAt: TIMESTAMP,
    stale: false,
  },
  owner: { name: 'Team', team: 'core' },
  notes: 'notes',
  verifiedAt: TIMESTAMP,
};

const dirs: string[] = [];

function tree(files: Record<string, unknown | string>): {
  root: string;
  repo: WorkingTreeCatalogRepository;
} {
  const root = mkdtempSync(join(tmpdir(), 'seamnex-catalog-'));
  dirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }
  const db = fakeDb();
  const config = { SEAMNEX_CATALOG_REPO_PATH: root } as unknown as AppConfig;
  return { root, repo: new WorkingTreeCatalogRepository(config, db.pool) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  h.execFileSync.mockReset();
});

describe('load', () => {
  it('reports an absent working tree as nothing to reconcile', async () => {
    const { root } = tree({});
    const repo = new WorkingTreeCatalogRepository(
      { SEAMNEX_CATALOG_REPO_PATH: root } as unknown as AppConfig,
      fakeDb().pool,
    );

    await expect(repo.load()).resolves.toEqual({
      revision: 'absent',
      documents: [],
      envSchemas: [],
      invalid: [],
    });
  });

  it('loads a valid entry and a valid environment schema', async () => {
    const { repo } = tree({
      'catalog/D01-01.json': ENTRY,
      'catalog/env/D01-01.json': { format: 'env-schema/v1', entryKey: 'D01-01', variables: [] },
    });

    const working = await repo.load();

    expect(working.documents).toEqual([ENTRY]);
    expect(working.envSchemas).toEqual([
      { format: 'env-schema/v1', entryKey: 'D01-01', variables: [] },
    ]);
    expect(working.invalid).toEqual([]);
    expect(working.revision).toMatch(/^content-[0-9a-f]{16}$/);
  });

  it('refuses a composed key whose filename disagrees with it, and protects the declared key', async () => {
    // ADR-BE-20 phase 1: the identity is the field, so a half-renamed tree is the failure this
    // closes — the old file is renamed before its `key` is, or the reverse, and the loader would
    // otherwise project the new identity and leave two documents claiming one slot.
    const { repo } = tree({ 'catalog/D1.json': { ...ENTRY, key: 'D01-01' } });

    const working = await repo.load();

    expect(working.documents).toEqual([]);
    expect(working.invalid).toEqual([
      {
        path: 'catalog/D1.json',
        scope: 'entry',
        key: 'D01-01',
        reason: 'filename stem must equal the composed key; this file declares D01-01.',
      },
    ]);
  });

  it('loads a composed key whose filename matches, and leaves a legacy stem to convention', async () => {
    // The cross-check applies to the grammar that can be renamed. Legacy stems stay convention until
    // phase 2, or a tree that was never renamed could not be loaded at all.
    const { repo } = tree({
      'catalog/D01-01.json': { ...ENTRY, key: 'D01-01' },
      'catalog/D7.json': { ...ENTRY, key: 'D7' },
    });

    const working = await repo.load();

    expect(working.documents.map((entry) => entry.key).sort()).toEqual(['D01-01', 'D7']);
    expect(working.invalid).toEqual([]);
  });

  it('produces a different revision when only the environment schema changes', async () => {
    const first = tree({ 'catalog/D01-01.json': ENTRY });
    const second = tree({
      'catalog/D01-01.json': ENTRY,
      'catalog/env/D01-01.json': { format: 'env-schema/v1', entryKey: 'D01-01', variables: [] },
    });

    const a = await first.repo.load();
    const b = await second.repo.load();

    expect(a.revision).not.toBe(b.revision);
  });

  it('produces a stable revision for identical content regardless of read order', async () => {
    const files = {
      'catalog/D01-01.json': ENTRY,
      'catalog/D02-01.json': { ...ENTRY, key: 'D02-01' },
    };
    const first = tree(files);
    const second = tree(files);

    expect((await first.repo.load()).revision).toBe((await second.repo.load()).revision);
  });

  it('reports an unparseable entry as invalid instead of dropping it', async () => {
    const { repo } = tree({ 'catalog/D01-01.json': '{ not json' });

    const working = await repo.load();

    expect(working.documents).toEqual([]);
    expect(working.invalid).toEqual([
      { path: 'catalog/D01-01.json', scope: 'entry', key: 'D01-01', reason: expect.any(String) },
    ]);
  });

  it('reports a schema-invalid entry with the failing field paths', async () => {
    const { repo } = tree({ 'catalog/D01-01.json': { ...ENTRY, httpPort: 0 } });

    const working = await repo.load();

    expect(working.documents).toEqual([]);
    expect(working.invalid[0]?.reason).toContain('httpPort');
  });

  it('normalises a non-Error read failure to "unreadable"', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seamnex-catalog-'));
    dirs.push(root);
    // A directory named like a document makes readFileSync throw an EISDIR system error.
    mkdirSync(join(root, 'catalog', 'D01-01.json'), { recursive: true });
    const repo = new WorkingTreeCatalogRepository(
      { SEAMNEX_CATALOG_REPO_PATH: root } as unknown as AppConfig,
      fakeDb().pool,
    );

    const working = await repo.load();

    expect(working.invalid[0]?.reason).toMatch(/EISDIR|illegal operation/);
  });

  it('normalises a non-Error read failure, which is what a broken mount raises', async () => {
    const { repo } = tree({ 'catalog/D01-01.json': ENTRY });
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw 'EIO from a stale NFS handle';
    });

    const working = await repo.load();

    expect(working.invalid).toEqual([
      { path: 'catalog/D01-01.json', scope: 'entry', key: 'D01-01', reason: 'unreadable' },
    ]);
  });

  it('ignores files that are not JSON documents', async () => {
    const { repo } = tree({ 'catalog/README.md': '# notes', 'catalog/D01-01.json': ENTRY });

    const working = await repo.load();
    expect(working.documents).toEqual([ENTRY]);
    expect(working.invalid).toEqual([]);
  });
});

describe('environment schemas', () => {
  it('returns none when the env directory is absent', async () => {
    const { repo } = tree({ 'catalog/D01-01.json': ENTRY });
    await expect(repo.load()).resolves.toMatchObject({ envSchemas: [] });
  });

  it('reports a schema-invalid environment file', async () => {
    const { repo } = tree({
      'catalog/D01-01.json': ENTRY,
      'catalog/env/D01-01.json': {
        format: 'env-schema/v1',
        entryKey: 'D01-01',
        variables: [{ name: 'lower' }],
      },
    });

    const working = await repo.load();

    expect(working.envSchemas).toEqual([]);
    expect(working.invalid[0]).toMatchObject({ scope: 'environment', key: 'D01-01' });
  });

  it('names both halves when a file is copied under the wrong name', async () => {
    const { repo } = tree({
      'catalog/D01-01.json': ENTRY,
      'catalog/env/D02-01.json': { format: 'env-schema/v1', entryKey: 'D01-01', variables: [] },
    });

    const working = await repo.load();

    expect(working.invalid).toEqual([
      {
        path: 'catalog/env/D02-01.json',
        scope: 'environment',
        key: 'D01-01',
        reason: 'entryKey "D01-01" does not match the filename "D02-01"',
      },
    ]);
  });

  it('keeps one schema per entry key and refuses a second spelling of it', async () => {
    const { repo } = tree({
      'catalog/D01-01.json': ENTRY,
      'catalog/env/D01-01.json': { format: 'env-schema/v1', entryKey: 'D01-01', variables: [] },
      'catalog/env/D01-01.b.json': {
        format: 'env-schema/v1',
        entryKey: 'D01-01',
        variables: [],
        appliesTo: { imageRef: 'espocrm/espocrm:8.0.0' },
      },
    });

    const working = await repo.load();

    // Only the file whose name matches its own `entryKey` is kept; the copy is reported.
    expect(working.envSchemas).toEqual([
      { format: 'env-schema/v1', entryKey: 'D01-01', variables: [] },
    ]);
    expect(working.invalid).toEqual([
      expect.objectContaining({ path: 'catalog/env/D01-01.b.json', scope: 'environment' }),
    ]);
  });

  it('normalises an unreadable environment file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seamnex-catalog-'));
    dirs.push(root);
    mkdirSync(join(root, 'catalog', 'env', 'D01-01.json'), { recursive: true });
    writeFileSync(join(root, 'catalog', 'D01-01.json'), JSON.stringify(ENTRY), 'utf8');
    const repo = new WorkingTreeCatalogRepository(
      { SEAMNEX_CATALOG_REPO_PATH: root } as unknown as AppConfig,
      fakeDb().pool,
    );

    const working = await repo.load();
    expect(working.invalid[0]).toMatchObject({ scope: 'environment', key: 'D01-01' });
  });
});

describe('revision', () => {
  it('uses the git head when the working tree is a repository', async () => {
    const { repo } = tree({ 'catalog/D01-01.json': ENTRY, '.git/HEAD': 'ref: refs/heads/main' });
    h.execFileSync.mockReturnValue('abc123def456\n');

    await expect(repo.load()).resolves.toMatchObject({ revision: 'abc123def456' });
    expect(h.execFileSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['rev-parse', 'HEAD']),
      {
        encoding: 'utf8',
      },
    );
  });

  it('falls back to the content hash when git fails', async () => {
    const { repo } = tree({ 'catalog/D01-01.json': ENTRY, '.git/HEAD': 'ref: refs/heads/main' });
    h.execFileSync.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    await expect(repo.load()).resolves.toMatchObject({
      revision: expect.stringMatching(/^content-/),
    });
  });
});

describe('write-behind records', () => {
  it('records a commit idempotently', async () => {
    const db = fakeDb([['INSERT INTO catalog_commit', []]]);
    const repo = new WorkingTreeCatalogRepository(
      { SEAMNEX_CATALOG_REPO_PATH: tmpdir() } as unknown as AppConfig,
      db.pool,
    );

    await repo.recordCommit({ sha: 'abc', kind: 'entry', actor: 'alice', message: 'msg' });

    expect(db.calls[0]?.params).toEqual(['abc', 'entry', 'alice', 'msg']);
    expect(db.calls[0]?.sql).toContain('ON CONFLICT (sha) DO NOTHING');
  });

  it('records drift with the entry key and source in the detail', async () => {
    const db = fakeDb([['INSERT INTO drift_record', []]]);
    const repo = new WorkingTreeCatalogRepository(
      { SEAMNEX_CATALOG_REPO_PATH: tmpdir() } as unknown as AppConfig,
      db.pool,
    );

    await repo.recordDrift('D01-01', 'expected', 'observed');

    expect(db.calls[0]?.params).toEqual([
      'expected',
      'observed',
      JSON.stringify({ entryKey: 'D01-01', source: 'catalog/reload' }),
    ]);
  });
});
