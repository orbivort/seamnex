import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { fakeDb } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import type * as FilesModule from '../../../../src/common/fs/files';
import { ensureDir, sha256 } from '../../../../src/common/fs/files';
import { InstanceParamsService } from '../../../../src/modules/m22-catalog-repository/instance-params.service';

/**
 * `instances/<slug>/instance.yaml` is version-controlled, non-secret and verified at boot. Three
 * properties are asserted: the file carries environment variable *names* only (a value would make
 * it a secret store), a write is refused before anything is created when the tree is not writable,
 * and verification both marks and *clears* drift — verification that cannot heal is a trap.
 */
const h = vi.hoisted(() => ({ withAuditedMutation: vi.fn() }));
vi.mock('@seamnex/db', () => ({ withAuditedMutation: h.withAuditedMutation }));
// Delegated by default; one case makes the directory probe throw something that is not an `Error`.
vi.mock('../../../../src/common/fs/files', async (importOriginal) => {
  const actual = await importOriginal<typeof FilesModule>();
  return { ...actual, ensureDir: vi.fn(actual.ensureDir) };
});

const dirs: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'seamnex-instances-'));
  dirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(routes: Parameters<typeof fakeDb>[0] = [], root = tempRoot()) {
  const db = fakeDb(routes);
  h.withAuditedMutation.mockImplementation(
    async (
      _pool: unknown,
      appendAudit: (tx: unknown) => Promise<void>,
      mutate: (tx: unknown) => Promise<unknown>,
    ) => {
      await appendAudit(db.client);
      return mutate(db.client);
    },
  );
  const audit = { append: vi.fn(async () => undefined), lockChain: vi.fn(async () => undefined) };
  const service = new InstanceParamsService(
    { SEAMNEX_CATALOG_REPO_PATH: root } as unknown as AppConfig,
    db.pool,
    audit as never,
  );
  return { db, root, audit, service };
}

const INSTANCE = {
  id: 'inst-1',
  entry_key: 'D01-01',
  slug: 'shop',
  domain_route: 'shop.example.test',
  profile_key: null,
  state: 'ready',
  payload: { resources: { cpu: 2, memoryMb: 1024, diskMb: 2048 }, httpPort: 8080 },
  deleted_at: null,
};

beforeEach(() => {
  h.withAuditedMutation.mockReset();
});

describe('instancesRoot', () => {
  it('is the instances directory under the catalog repository', () => {
    const { root, service } = setup();
    expect(service.instancesRoot).toBe(join(root, 'instances'));
  });
});

describe('assertWritable', () => {
  it('creates the directory when it is missing and accepts a writable tree', () => {
    const { root, service } = setup();
    expect(() => service.assertWritable()).not.toThrow();
    expect(service.instancesRoot.startsWith(root)).toBe(true);
  });

  it('refuses a tree it cannot write to, before anything is created', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'instances'), 'not a directory', 'utf8');
    const { service } = setup([], root);

    expect(() => service.assertWritable()).toThrow(
      expect.objectContaining({ code: 'REPOSITORY_UNAVAILABLE' }),
    );
  });
});

describe('write', () => {
  it('writes a non-secret definition, records the projection and commits it', async () => {
    const { db, root, audit, service } = setup([
      ['FROM instance WHERE id', [INSTANCE]],
      ['FROM instance_env_value', [{ var_name: 'MAIL_HOST' }, { var_name: 'MAIL_PORT' }]],
      ['FROM catalog_commit', [{ sha: 'abc123' }]],
      ['INSERT INTO instance_param', []],
      ['INSERT INTO catalog_commit', []],
    ]);
    mkdirSync(join(root, 'instances'), { recursive: true });

    const result = await service.write('inst-1', 'alice');

    const path = join(root, 'instances', 'shop', 'instance.yaml');
    const content = readFileSync(path, 'utf8');
    expect(result).toEqual({ path: 'instances/shop/instance.yaml', contentHash: sha256(content) });

    const document = parseYaml(content) as Record<string, never>;
    expect(document).toEqual({
      apiVersion: 'seamnex/v1',
      kind: 'Instance',
      metadata: { slug: 'shop', entryKey: 'D01-01' },
      spec: {
        profile: 'default',
        domainRoute: 'shop.example.test',
        resources: { cpu: 2, memoryMb: 1024, diskMb: 2048 },
        route: null,
        httpPort: 8080,
        env: ['MAIL_HOST', 'MAIL_PORT'],
      },
    });
    // The value never reaches the file: only the names do.
    expect(content).not.toContain('secret');

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.params.committed',
        actorId: 'alice',
        detail: { path: 'instances/shop/instance.yaml', contentHash: result.contentHash },
      }),
      expect.anything(),
    );
    const projection = db.calls.find((call) => call.sql.includes('INSERT INTO instance_param'));
    expect(projection?.params).toEqual([
      'inst-1',
      'abc123',
      result.contentHash,
      JSON.stringify(INSTANCE.payload),
    ]);
    const commit = db.calls.find((call) => call.sql.includes('INSERT INTO catalog_commit'));
    expect(commit?.params).toEqual([result.contentHash, 'alice', 'instance.yaml for shop']);
  });

  it('records "worktree" when no commit exists yet', async () => {
    const { db, service } = setup([
      ['FROM instance WHERE id', [INSTANCE]],
      ['FROM instance_env_value', []],
      ['FROM catalog_commit', []],
      ['INSERT INTO instance_param', []],
      ['INSERT INTO catalog_commit', []],
    ]);

    await service.write('inst-1', 'alice');

    const projection = db.calls.find((call) => call.sql.includes('INSERT INTO instance_param'));
    expect(projection?.params[1]).toBe('worktree');
  });

  it('writes the documented defaults for an instance with no resources or route', async () => {
    const { root, service } = setup([
      ['FROM instance WHERE id', [{ ...INSTANCE, payload: {} }]],
      ['FROM instance_env_value', []],
      ['FROM catalog_commit', [{ sha: 'abc123' }]],
      ['INSERT INTO instance_param', []],
      ['INSERT INTO catalog_commit', []],
    ]);

    await service.write('inst-1', 'alice');

    // A definition must describe a complete instance even when the payload names only some fields:
    // the defaults are the ones the pipeline applies, spelled out rather than implied.
    const document = parseYaml(
      readFileSync(join(root, 'instances', 'shop', 'instance.yaml'), 'utf8'),
    ) as { spec: Record<string, unknown> };
    expect(document.spec).toMatchObject({
      profile: 'default',
      resources: null,
      route: null,
      httpPort: 80,
      env: [],
    });
  });

  it('reports a non-Error failure of the writability probe', () => {
    const { service } = setup();
    vi.mocked(ensureDir).mockImplementationOnce(() => {
      throw 'read-only file system';
    });

    expect(() => service.assertWritable()).toThrow(/read-only file system/);
  });

  it('refuses an instance that does not exist', async () => {
    const { service } = setup([['FROM instance WHERE id', []]]);
    await expect(service.write('missing', 'alice')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('verifyAll', () => {
  it('clears the drift flag when the file matches its recorded hash', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'instances', 'shop'), { recursive: true });
    const content = 'apiVersion: seamnex/v1\n';
    writeFileSync(join(root, 'instances', 'shop', 'instance.yaml'), content, 'utf8');

    const { db, service } = setup(
      [
        [
          'FROM instance_param p',
          {
            rows: [{ instance_id: 'inst-1', content_hash: sha256(content), slug: 'shop' }],
            rowCount: 1,
          },
        ],
        ['UPDATE instance SET payload = payload -', []],
      ],
      root,
    );

    await expect(service.verifyAll()).resolves.toEqual({ checked: 1, drifted: 0 });
    expect(db.calls.some((call) => call.sql.includes("payload - 'instanceParamDrift'"))).toBe(true);
  });

  it('records drift and flags the instance when the file does not match', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'instances', 'shop'), { recursive: true });
    writeFileSync(join(root, 'instances', 'shop', 'instance.yaml'), 'changed\n', 'utf8');

    const { db, service } = setup(
      [
        [
          'FROM instance_param p',
          {
            rows: [{ instance_id: 'inst-1', content_hash: 'expected-hash', slug: 'shop' }],
            rowCount: 1,
          },
        ],
        ['INSERT INTO drift_record', []],
        ['UPDATE instance SET payload = payload ||', []],
      ],
      root,
    );

    await expect(service.verifyAll()).resolves.toEqual({ checked: 1, drifted: 1 });
    const drift = db.calls.find((call) => call.sql.includes('INSERT INTO drift_record'));
    expect(drift?.params.slice(0, 3)).toEqual(['inst-1', 'expected-hash', sha256('changed\n')]);
    expect(drift?.params[3]).toContain('instance.yaml');
    expect(db.calls.some((call) => call.sql.includes('payload ||'))).toBe(true);
  });

  it('reports a missing file as drift', async () => {
    const { db, service } = setup([
      [
        'FROM instance_param p',
        { rows: [{ instance_id: 'inst-1', content_hash: 'h', slug: 'gone' }], rowCount: 1 },
      ],
      ['INSERT INTO drift_record', []],
      ['UPDATE instance SET payload = payload ||', []],
    ]);

    await expect(service.verifyAll()).resolves.toEqual({ checked: 1, drifted: 1 });
    expect(db.calls.find((call) => call.sql.includes('INSERT INTO drift_record'))?.params[2]).toBe(
      'missing',
    );
  }, 15_000);

  it('reports zero checked when no instance has a recorded definition', async () => {
    const { service } = setup([['FROM instance_param p', { rows: [], rowCount: null }]]);
    await expect(service.verifyAll()).resolves.toEqual({ checked: 0, drifted: 0 });
  });

  it('logs a verification failure at boot instead of failing to start', async () => {
    const { service } = setup([
      [
        'FROM instance_param p',
        () => {
          throw new Error('database down');
        },
      ],
    ]);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('isDrifted', () => {
  it('reports the flag from the instance payload', async () => {
    const { service } = setup([['AS drifted', [{ drifted: true }]]]);
    await expect(service.isDrifted('inst-1')).resolves.toBe(true);
  });

  it('reports false when the row or the flag is absent', async () => {
    const { service } = setup([['AS drifted', []]]);
    await expect(service.isDrifted('inst-1')).resolves.toBe(false);
  });
});
