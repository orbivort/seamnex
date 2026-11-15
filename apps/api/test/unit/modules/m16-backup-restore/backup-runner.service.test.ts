import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { AppError } from '../../../../src/common/problem/app-error';
import { fakeDb, type Route } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { PipelineRegistry, type PipelineContext } from '../../../../src/jobs/pipeline-registry';
import { BackupRunnerService } from '../../../../src/modules/m16-backup-restore/backup-runner.service';
import {
  createPlatformManifest,
  plannedArtefact,
  referenceArtefact,
} from '../../../../src/modules/m16-backup-restore/platform-manifest';

/**
 * The runner owns two things: the stage list each job kind is executed by, and the side effects of a
 * stage — dump, encrypt, upload, settle. Every collaborator that touches a socket (Docker, S3, age,
 * the CLI) is a double, and the only real filesystem it writes is the scratch backup directory, which
 * is what makes "the .pgpass is 0600" and "the manifest the restore reads is the manifest the verify
 * stage parsed" assertable facts rather than mocks.
 */
const SCRATCH = mkdtempSync(join(tmpdir(), 'seamnex-backup-runner-'));

const state = vi.hoisted(() => ({ runOrThrow: vi.fn() }));

// The CLI is the one collaborator a unit test cannot fake with an injected double: the stages call
// the module directly. Everything else in the module is kept, so `docker.client` still resolves.
vi.mock('../../../../src/common/exec/exec', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runOrThrow: state.runOrThrow };
});

const EDGE_DIR = join(SCRATCH, 'traefik-dynamic');
const CATALOG_DIR = join(SCRATCH, 'catalog-repo');

const CONFIG = {
  SEAMNEX_BACKUP_TMP_DIR: join(SCRATCH, 'backups'),
  SEAMNEX_INSTANCE_DATA_DIR: join(SCRATCH, 'instances'),
  SEAMNEX_TRAEFIK_DYNAMIC_DIR: EDGE_DIR,
  SEAMNEX_CATALOG_REPO_PATH: CATALOG_DIR,
  SEAMNEX_ROOT_KEY_ESCROW_REF: 'vault://platform/root-key',
  SEAMNEX_EDGE_CONFIG_REF: 'vault://edge/ingress-tls',
  SEAMNEX_KEYCLOAK_DB_URL: 'postgres://keycloak:k%40y@127.0.0.1:5432/seamnex_keycloak',
  SEAMNEX_PLATFORM_DB_URL: '',
  SEAMNEX_AGE_RECIPIENT: 'age1recipient',
  SEAMNEX_DOCKER_PATH_MAP: '',
  SEAMNEX_DOCKER_HOST: 'unix:///var/run/docker.sock',
  DATABASE_URL: 'postgres://seamnex:p%40ss@127.0.0.1:5432/seamnex_platform',
} as unknown as AppConfig;

const INSTANCE: Route = [
  'SELECT id, slug FROM instance WHERE id = $1',
  [{ id: 'inst-1', slug: 'crm' }],
];

type Ctx = PipelineContext & { readonly lines: string[] };

function context(payload: Record<string, unknown> = { backupId: 'bkp-1' }): Ctx {
  const lines: string[] = [];
  const ctx: Ctx = {
    jobId: 'job-1',
    instanceId: 'inst-1',
    actorId: 'user-1',
    action: 'backup',
    payload,
    lines,
    log: vi.fn(async (stream, line) => {
      lines.push(`${stream}:${line}`);
    }),
    cancelled: vi.fn(async () => false),
  };
  return ctx;
}

/**
 * The applied definition every fixture starts from: no top-level `volumes:`, so a backup of it is
 * complete with the database. Tests that need a declared volume override this route.
 */
const NO_VOLUMES_DEFINITION: Route = [
  'SELECT content FROM render_file',
  [{ content: 'services:\n  app:\n    image: app:1\n' }],
];

function runner(routes: readonly Route[] = [], config: Partial<AppConfig> = {}) {
  const db = fakeDb([...routes, NO_VOLUMES_DEFINITION]);
  const audit = {
    append: vi.fn(async () => ({ seq: '1', hash: 'h' })),
    exportAnchors: vi.fn(async () => ({
      anchors: [
        {
          day: '2026-11-15',
          lastSeq: '42',
          lastHash: 'a'.repeat(64),
          signature: null,
          storedAt: '2026-11-15T00:00:00.000Z',
        },
      ],
      chainHead: { seq: '42', hash: 'b'.repeat(64), ts: '2026-11-15T05:00:00.000Z' },
    })),
  };
  const secrets = { rootKeyId: vi.fn(() => '0123456789abcdef') };
  const docker = {
    imageExists: vi.fn(async (_ref: string) => true),
    volumeExists: vi.fn(async (_name: string) => true),
    ensureVolume: vi.fn(async (_name: string, _labels: Record<string, string>) => undefined),
    containers: vi.fn(async (_labels: readonly string[]) => [] as { id: string; state: string }[]),
    stop: vi.fn(async (_containerId: string, _graceSeconds: number) => undefined),
    ensureNetwork: vi.fn(async (_name: string, _labels: Record<string, string>) => undefined),
    composeUp: vi.fn(
      async (_project: unknown, _onLine?: (line: string) => Promise<void>) => undefined,
    ),
  };
  const objects: Record<string, string> = {};
  const store = {
    putFile: vi.fn(async (key: string, _path: string) => ({ key, bytes: 100 })),
    putText: vi.fn(async (_key: string, _body: string) => undefined),
    // Verification asks the target, not the manifest, whether an object is really there.
    exists: vi.fn(async (key: string) => key in objects),
    download: vi.fn(async (key: string, path: string) => {
      writeFileSync(path, objects[key] ?? '');
    }),
  };
  const age = {
    // The real encryptor writes `<path>.age` next to the plaintext; the upload stage then streams
    // that file for its digest, so the double has to produce it.
    encrypt: vi.fn(async (path: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.age`, `encrypted:${path}`);
      return { path: `${path}.age`, recipient: 'age1recipient' };
    }),
    decrypt: vi.fn(async (path: string) => path.replace(/\.age$/, '')),
    recipientId: vi.fn(() => 'age1recipient'),
    identityId: vi.fn(() => 'escrowed'),
  };
  const keycloak = { exportRealm: vi.fn(async () => ({ realm: 'seamnex' })) };
  const pipelines = new PipelineRegistry();
  const service = new BackupRunnerService(
    db.pool,
    { ...CONFIG, ...config } as AppConfig,
    audit as never,
    docker as never,
    store as never,
    age as never,
    pipelines,
    keycloak as never,
    secrets as never,
  );
  service.onModuleInit();
  const stage = (kind: string, index: number) => {
    const found = pipelines.stages(kind)?.[index];
    if (found === undefined) throw new Error(`no stage ${index} in ${kind}`);
    return found.run;
  };
  return {
    db,
    audit,
    docker,
    store,
    age,
    keycloak,
    secrets,
    pipelines,
    objects,
    service,
    stage,
  };
}

beforeEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  // A platform capture refuses when a required directory is absent, so every test starts on a host
  // that has the edge tree and the catalogue tree.
  mkdirSync(EDGE_DIR, { recursive: true });
  mkdirSync(CATALOG_DIR, { recursive: true });
  state.runOrThrow.mockReset();
  state.runOrThrow.mockResolvedValue({ code: 0, stdout: '', stderr: '', truncated: false });
  for (const method of ['debug', 'log', 'warn', 'error'] as const) {
    vi.spyOn(Logger.prototype, method).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('pipeline registration', () => {
  it('registers the stage list of every kind the module owns', () => {
    const { pipelines } = runner();

    expect(pipelines.registered()).toEqual([
      'backup',
      'platform-backup',
      'platform-restore',
      'restore',
      'verify',
    ]);
    expect(pipelines.stepsFor('backup')).toEqual(['Dump databases', 'Encrypt and upload']);
    expect(pipelines.stepsFor('verify')).toEqual([
      'Restore into a scratch stack',
      'Record evidence',
    ]);
    expect(pipelines.stepsFor('restore')).toEqual([
      'Load artefacts',
      'Restore data',
      'Start from the stored render set',
      'Record restore',
    ]);
    expect(pipelines.stepsFor('platform-backup')).toEqual([
      'Dump platform state',
      'Upload platform backup',
    ]);
    expect(pipelines.stepsFor('platform-restore')).toEqual([
      'Restore identity provider',
      'Restore control plane',
      'Hold the gate for login verification',
    ]);
  });

  it('registers a failure handler for the two platform kinds, which need their row settled', () => {
    const { pipelines } = runner();

    expect(pipelines.failureHandler('platform-backup')).toBeTypeOf('function');
    expect(pipelines.failureHandler('platform-restore')).toBeTypeOf('function');
  });
});

describe('dump stage', () => {
  const servicesRoute = (...rows: Record<string, unknown>[]): Route => [
    'FROM instance_service WHERE instance_id',
    rows,
  ];
  const manifestWrite: Route = ['UPDATE backup SET manifest = $2::jsonb', []];

  it('dumps every database engine, archives every volume and stores the manifest', async () => {
    const { db, age, stage } = runner([
      INSTANCE,
      ['FROM instance i WHERE i.id = $1', [{ id: 'rs-1' }]],
      servicesRoute(
        { service_name: 'db', image_ref: 'postgres:16-alpine' },
        { service_name: 'web', image_ref: 'nginx:1.27' },
        { service_name: 'store', image_ref: 'mariadb:11' },
        { service_name: 'cache', image_ref: 'mysql:8' },
      ),
      [
        'FROM instance_env_value',
        [
          { var_name: 'DATABASE_URL', value_enc: null },
          { var_name: 'DATABASE_URL', value_enc: Buffer.from('postgres://app@db:5432/app') },
          { var_name: 'MYSQL_USER', value_enc: Buffer.from('root') },
          { var_name: 'MARIADB_PASSWORD', value_enc: Buffer.from('secret') },
          { var_name: 'MYSQL_PORT', value_enc: null },
          { var_name: 'SMTP_HOST', value_enc: Buffer.from('mail') },
        ],
      ],
      ['FROM instance_volume WHERE instance_id', [{ name: 'seamnex-vol-1' }]],
      manifestWrite,
    ]);
    const ctx = context();

    await stage('backup', 0)(ctx);

    // Four services, three of which are databases; the web image is captured but not dumped.
    const dumpCalls = state.runOrThrow.mock.calls.filter((call) =>
      String(call[1]).includes('/backup/'),
    );
    expect(dumpCalls).toHaveLength(3);
    expect(age.recipientId).toHaveBeenCalled();
    const manifest = JSON.parse(
      String(db.calls.find((call) => call.sql.includes('UPDATE backup SET manifest'))?.params[1]),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      version: 1,
      renderSetId: 'rs-1',
      includes: ['database', 'volumes'],
      encryption: { recipient: 'age1recipient', identityId: 'escrowed' },
    });
    expect(manifest.services).toHaveLength(4);
    expect(manifest.engineDumps).toEqual([
      { service: 'db', engine: 'postgres', objectKey: 'bkp-1/db.dump.age' },
      { service: 'store', engine: 'mariadb', objectKey: 'bkp-1/store.dump.age' },
      { service: 'cache', engine: 'mysql', objectKey: 'bkp-1/cache.dump.age' },
    ]);
    expect(manifest.volumes).toEqual([
      { name: 'seamnex-vol-1', archiveKey: 'bkp-1/seamnex-vol-1.tar.zst.age', digest: '' },
    ]);
    expect(ctx.lines.some((line) => line.includes('volume seamnex-vol-1: archive written'))).toBe(
      true,
    );
  });

  /**
   * ISSUE-02 / AC-13 — the load-bearing test: a product whose applied definition declares a volume
   * but which has no registered volume would otherwise produce a "complete" backup of the database
   * alone. It must refuse, before uploading anything, and say what to do.
   */
  it('refuses when the definition declares volumes but none is registered for the instance', async () => {
    const { db, stage } = runner([
      INSTANCE,
      ['FROM instance i WHERE i.id = $1', [{ id: 'rs-1' }]],
      [
        'SELECT content FROM render_file',
        [
          {
            content: 'services:\n  app:\n    volumes:\n      - data:/data\nvolumes:\n  data:\n',
          },
        ],
      ],
      servicesRoute({ service_name: 'db', image_ref: 'postgres:16' }),
      ['FROM instance_env_value', []],
      ['FROM instance_volume WHERE instance_id', []],
      manifestWrite,
    ]);

    await expect(stage('backup', 0)(context())).rejects.toMatchObject({
      code: 'BACKUP_UNUSABLE',
      detail:
        'crm declares 1 data volume(s) (data) but none is registered for the instance, so a backup would capture the database and none of the files.',
      remediation: expect.stringContaining('Reconfigure the instance'),
    });
    // Nothing was captured and no manifest was written, so there is no misleading half-set.
    expect(state.runOrThrow).not.toHaveBeenCalled();
    expect(db.calls.some((call) => call.sql.includes('UPDATE backup SET manifest'))).toBe(false);
  });

  it('skips a registered volume the daemon no longer holds and says so', async () => {
    const { db, stage, docker } = runner([
      INSTANCE,
      ['FROM instance i WHERE i.id = $1', [{ id: 'rs-1' }]],
      servicesRoute({ service_name: 'db', image_ref: 'postgres:16' }),
      [
        'FROM instance_env_value',
        [{ var_name: 'DATABASE_URL', value_enc: Buffer.from('postgres://app@db:5432/app') }],
      ],
      ['FROM instance_volume WHERE instance_id', [{ name: 'seamnex-vol-gone' }]],
      manifestWrite,
    ]);
    docker.volumeExists.mockResolvedValue(false);
    const ctx = context();

    await stage('backup', 0)(ctx);

    const manifest = JSON.parse(
      String(db.calls.find((call) => call.sql.includes('UPDATE backup SET manifest'))?.params[1]),
    ) as { includes: string[]; volumes: unknown[] };
    // An absent volume holds nothing, so the set is honest about containing only the database.
    expect(manifest.volumes).toEqual([]);
    expect(manifest.includes).toEqual(['database']);
    expect(ctx.lines).toContain(
      'system:volume seamnex-vol-gone is registered but absent from the daemon; it holds no data and is not captured',
    );
  });

  it('passes the stored connection to pg_dump through the environment, not the argv', async () => {
    const { stage } = runner([
      INSTANCE,
      ['FROM instance i WHERE i.id = $1', [{ id: 'rs-1' }]],
      servicesRoute({ service_name: 'db', image_ref: 'postgres:16' }),
      [
        'FROM instance_env_value',
        [{ var_name: 'DATABASE_URL', value_enc: Buffer.from('postgres://app@db:5432/app') }],
      ],
      ['FROM instance_volume WHERE instance_id', []],
      ['UPDATE backup SET manifest = $2::jsonb', []],
    ]);

    await stage('backup', 0)(context());

    const [, args, options] = state.runOrThrow.mock.calls[0] ?? [];
    expect(args).toContain('PGURL=postgres://app@db:5432/app');
    expect(args).not.toContain('postgres://app@db:5432/app');
    expect(args).toContain('seamnex-inst-crm');
    expect(args).toEqual(expect.arrayContaining(['sh', '-c']));
    expect(String(args).includes('pg_dump --format=custom')).toBe(true);
    expect(options).toEqual({
      env: { DOCKER_HOST: 'unix:///var/run/docker.sock' },
      timeoutMs: 900_000,
    });
  });

  it('falls back to the conventional local database when none is configured', async () => {
    const { stage } = runner([
      INSTANCE,
      ['FROM instance i WHERE i.id = $1', []],
      servicesRoute({ service_name: 'db', image_ref: 'postgres:16' }),
      ['FROM instance_env_value', []],
      ['FROM instance_volume WHERE instance_id', []],
      ['UPDATE backup SET manifest = $2::jsonb', []],
    ]);

    await stage('backup', 0)(context());

    const [, args] = state.runOrThrow.mock.calls[0] ?? [];
    expect(args).toContain('PGURL=postgres://postgres@db:5432/postgres');
  });

  it('uses mysqldump for a mysql-family engine and forwards its variables', async () => {
    const { stage } = runner([
      INSTANCE,
      ['FROM instance i WHERE i.id = $1', [{ id: 'rs-1' }]],
      servicesRoute({ service_name: 'store', image_ref: 'mariadb:11' }),
      [
        'FROM instance_env_value',
        [
          { var_name: 'MYSQL_USER', value_enc: Buffer.from('root') },
          { var_name: 'MARIADB_PASSWORD', value_enc: Buffer.from('secret') },
        ],
      ],
      ['FROM instance_volume WHERE instance_id', []],
      ['UPDATE backup SET manifest = $2::jsonb', []],
    ]);

    await stage('backup', 0)(context());

    const [, args] = state.runOrThrow.mock.calls[0] ?? [];
    expect(args).toContain('MYSQL_USER=root');
    expect(args).toContain('MARIADB_PASSWORD=secret');
    expect(String(args).includes('mysqldump --single-transaction')).toBe(true);
  });

  it.each([
    ['an unknown image', 'nginx:1.27'],
    ['an image with no engine at all', 'alpine:3.20'],
  ])('captures %s without attempting a dump', async (_label, imageRef) => {
    const { stage } = runner([
      INSTANCE,
      ['FROM instance i WHERE i.id = $1', [{ id: 'rs-1' }]],
      servicesRoute({ service_name: 'web', image_ref: imageRef }),
      ['FROM instance_volume WHERE instance_id', []],
      ['UPDATE backup SET manifest = $2::jsonb', []],
    ]);

    await stage('backup', 0)(context());

    expect(state.runOrThrow).not.toHaveBeenCalled();
  });

  it('refuses a payload without a backup id instead of dumping into an unnamed directory', async () => {
    const { stage } = runner();

    await expect(stage('backup', 0)(context({}))).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The job payload is missing "backupId".',
    });
  });

  it('refuses when the backup target no longer exists', async () => {
    const { stage } = runner([['SELECT id, slug FROM instance WHERE id = $1', []]]);

    await expect(stage('backup', 0)(context())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No instance inst-1.',
    });
  });
});

describe('upload stage', () => {
  function uploadRoutes(manifest: Record<string, unknown>): Route[] {
    return [
      [
        'SELECT manifest, instance_id FROM backup WHERE id = $1',
        [{ manifest, instance_id: 'inst-1' }],
      ],
      ['UPDATE backup SET state = ', []],
    ];
  }

  it('encrypts and uploads every artefact, then records the finished backup', async () => {
    const { db, audit, store, age, stage } = runner(
      uploadRoutes({
        version: 1,
        services: [],
        engineDumps: [{ service: 'db', engine: 'postgres', objectKey: 'bkp-1/db.dump.age' }],
        volumes: [
          { name: 'seamnex-vol-1', archiveKey: 'bkp-1/seamnex-vol-1.tar.zst.age', digest: '' },
        ],
        includes: ['database'],
      }),
    );
    store.putFile
      .mockResolvedValueOnce({ key: 'bkp-1/db.dump.age', bytes: 100 })
      .mockResolvedValueOnce({ key: 'bkp-1/seamnex-vol-1.tar.zst.age', bytes: 250 });
    const ctx = context();

    await stage('backup', 1)(ctx);

    // The plaintext path is what the encryptor returns; the key is what the store acknowledged.
    expect(age.encrypt.mock.calls.map((call) => String(call[0]))).toEqual([
      join(CONFIG.SEAMNEX_BACKUP_TMP_DIR, 'bkp-1', 'db.dump'),
      join(CONFIG.SEAMNEX_BACKUP_TMP_DIR, 'bkp-1', 'seamnex-vol-1.tar.zst'),
    ]);
    const update = db.calls.find((call) => call.sql.includes('UPDATE backup SET state = '));
    expect(update?.params.slice(0, 3)).toEqual(['bkp-1', 350, 'bkp-1/db.dump.age']);
    // The digest is recorded on the volume the archive belongs to, and only there.
    const stored = JSON.parse(String(update?.params[3])) as {
      volumes: { digest: string }[];
    };
    expect(stored.volumes[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(store.putText).toHaveBeenCalledWith(
      'bkp-1/manifest.json',
      expect.stringContaining('"version": 1'),
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.backup.succeeded',
        detail: { bytes: 350, artefacts: 2 },
      }),
    );
    expect(ctx.lines).toContain('system:backup bkp-1 uploaded (350 bytes)');
  });

  it('records the manifest as the primary artefact when the backup held none', async () => {
    const { db, stage } = runner(
      uploadRoutes({ version: 1, services: [], engineDumps: [], volumes: [], includes: [] }),
    );

    await stage('backup', 1)(context());

    const update = db.calls.find((call) => call.sql.includes('UPDATE backup SET state = '));
    expect(update?.params.slice(0, 3)).toEqual(['bkp-1', 0, 'bkp-1/manifest.json']);
  });

  it('refuses to upload a backup whose manifest row disappeared', async () => {
    const { stage } = runner([['SELECT manifest, instance_id FROM backup WHERE id = $1', []]]);

    await expect(stage('backup', 1)(context())).rejects.toThrow(TypeError);
  });
});

describe('verify stage', () => {
  const backupRoute = (object_key: string | null): Route => [
    'SELECT object_key, instance_id FROM backup WHERE id = $1',
    [{ object_key, instance_id: 'inst-1' }],
  ];

  function verifyRunner(manifest: Record<string, unknown>, routes: readonly Route[] = []) {
    const env = runner([backupRoute('bkp-1/manifest.json'), ...routes]);
    env.objects['bkp-1/manifest.json'] = JSON.stringify(manifest);
    return env;
  }

  it('parses the uploaded manifest, checks every object it names and logs what it holds', async () => {
    const env = verifyRunner({
      version: 1,
      services: [{ name: 'db', imageRef: 'postgres:16', imageDigest: '' }],
      engineDumps: [{ service: 'db', engine: 'postgres', objectKey: 'bkp-1/db.dump.age' }],
      volumes: [{ name: 'v', archiveKey: 'bkp-1/x.age', digest: 'a'.repeat(64) }],
      includes: [],
    });
    env.objects['bkp-1/db.dump.age'] = 'dump';
    env.objects['bkp-1/x.age'] = 'archive';
    const { store, docker, stage } = env;
    const ctx = context();

    await stage('verify', 0)(ctx);

    expect(store.download).toHaveBeenCalledWith(
      'bkp-1/manifest.json',
      join(CONFIG.SEAMNEX_BACKUP_TMP_DIR, 'bkp-1-verify', 'manifest.json'),
    );
    expect(store.exists.mock.calls).toEqual([['bkp-1/db.dump.age'], ['bkp-1/x.age']]);
    expect(ctx.lines).toContain(
      'stdout:manifest verified: 1 dump(s), 1 volume(s), 2 object(s) present',
    );
    expect(docker.imageExists).toHaveBeenCalledWith('postgres:16');
  });

  it('refuses a backup whose volume archive never reached the target', async () => {
    const { stage } = verifyRunner({
      version: 1,
      services: [],
      engineDumps: [],
      volumes: [{ name: 'seamnex-crm-data', archiveKey: 'bkp-1/data.age', digest: 'a'.repeat(64) }],
      includes: ['volumes'],
    });

    // The manifest names the archive; the store does not have it. That is the failure the old
    // "verified" log could not see, and it must not end in a verified_at.
    await expect(stage('verify', 0)(context())).rejects.toMatchObject({
      code: 'BACKUP_UNUSABLE',
      detail: expect.stringContaining(
        'volume seamnex-crm-data (bkp-1/data.age is not in the target)',
      ),
      remediation: expect.stringContaining('Take the backup again'),
    });
  });

  it('refuses a captured volume with no digest to compare on restore', async () => {
    const { stage } = verifyRunner(
      {
        version: 1,
        services: [],
        engineDumps: [],
        volumes: [{ name: 'seamnex-crm-data', archiveKey: 'bkp-1/data.age', digest: '' }],
        includes: ['volumes'],
      },
      [],
    );

    await expect(stage('verify', 0)(context())).rejects.toMatchObject({
      code: 'BACKUP_UNUSABLE',
      detail: expect.stringContaining('volume seamnex-crm-data (no digest recorded)'),
    });
  });

  it.each([
    ['an absent object key', null],
    ['no backup row at all', undefined],
  ])('refuses %s rather than verifying nothing', async (_label, key) => {
    const { stage } = runner([backupRoute(key as string | null)]);

    await expect(stage('verify', 0)(context())).rejects.toMatchObject({
      code: 'BACKUP_UNUSABLE',
      detail: 'The backup has no uploaded artefact.',
    });
  });

  it('refuses a manifest from a newer format', async () => {
    const { stage } = verifyRunner({ version: 2, services: [], engineDumps: [], volumes: [] });

    await expect(stage('verify', 0)(context())).rejects.toMatchObject({
      code: 'BACKUP_UNUSABLE',
      detail: 'Unsupported manifest version 2.',
    });
  });

  it('refuses a backup whose images are not present on this host', async () => {
    const { docker, stage } = verifyRunner({
      version: 1,
      services: [{ name: 'db', imageRef: 'postgres:16', imageDigest: '' }],
      engineDumps: [],
      volumes: [],
    });
    docker.imageExists.mockResolvedValue(false);

    await expect(stage('verify', 0)(context())).rejects.toMatchObject({
      code: 'BACKUP_UNUSABLE',
      detail: 'Image postgres:16 needed by the backup is not present on this host.',
    });
  });

  it('skips a service the manifest recorded without an image reference', async () => {
    const { docker, stage } = verifyRunner({
      version: 1,
      services: [
        { name: 'draft', imageRef: '', imageDigest: '' },
        { name: 'db', imageRef: 'postgres:16', imageDigest: '' },
      ],
      engineDumps: [],
      volumes: [],
    });

    await expect(stage('verify', 0)(context())).resolves.toBeUndefined();
    expect(docker.imageExists.mock.calls).toEqual([['postgres:16']]);
  });
});

describe('record verification stage', () => {
  const written: Route = ['UPDATE backup SET verified_at = now()', []];

  it('records the evidence of a plain backup verification', async () => {
    const { db, audit, stage } = runner([written]);

    await stage('verify', 1)(context());

    expect(db.calls[0]?.params).toEqual(['bkp-1', 'scratch-stack smoke test']);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'instance.backup.verified', detail: { mode: 'backup' } }),
    );
  });

  it('closes a drill with the job as evidence', async () => {
    const { db, stage } = runner([written, ['UPDATE restore_drill', []]]);

    await stage('verify', 1)(context({ backupId: 'bkp-1', mode: 'drill', drillId: 'drill-1' }));

    const drill = db.calls.find((call) => call.sql.includes('UPDATE restore_drill'));
    expect(drill?.params).toEqual(['drill-1', 'job:job-1']);
  });

  it.each([
    ['a drill without a drill id', { backupId: 'bkp-1', mode: 'drill' }],
    ['a mode that is not a string', { backupId: 'bkp-1', mode: 42 }],
  ])('leaves the drill alone for %s', async (_label, payload) => {
    const { db, stage } = runner([written]);

    await stage('verify', 1)(context(payload));

    expect(db.calls.some((call) => call.sql.includes('UPDATE restore_drill'))).toBe(false);
  });
});

describe('restore stages', () => {
  const preparing: Route = ["UPDATE restore_run SET phase = 'preparing'", []];
  const products: Route = ["UPDATE restore_run SET phase = 'products'", []];
  const verifyPhase: Route = ["UPDATE restore_run SET phase = 'verify'", []];
  const complete: Route = ['UPDATE restore_run SET state = ', []];
  const RESTORE = { backupId: 'bkp-1', restoreId: 'run-1' };

  it('prepares the restore workspace', async () => {
    const { db, stage } = runner([preparing]);
    const ctx = context({ backupId: 'bkp-1', restoreId: 'run-1' });

    await stage('restore', 0)(ctx);

    expect(db.calls[0]?.params).toEqual(['run-1']);
    expect(ctx.lines[0]).toContain('restore workspace');
  });

  it('restores every volume archive and moves the run on to the products phase', async () => {
    const { store, age, docker, stage } = runner([
      INSTANCE,
      [
        'SELECT manifest, instance_id, render_set_id FROM backup WHERE id = $1',
        [
          {
            manifest: {
              version: 1,
              services: [],
              engineDumps: [],
              volumes: [
                {
                  name: 'seamnex-vol-1',
                  archiveKey: 'bkp-1/seamnex-vol-1.tar.zst.age',
                  digest: '',
                },
              ],
              includes: [],
            },
            instance_id: 'inst-1',
            render_set_id: null,
          },
        ],
      ],
      preparing,
      products,
    ]);
    const ctx = context({ backupId: 'bkp-1', restoreId: 'run-1' });

    await stage('restore', 0)(ctx);
    await stage('restore', 1)(ctx);

    const archive = join(CONFIG.SEAMNEX_BACKUP_TMP_DIR, 'bkp-1-restore', 'seamnex-vol-1.tar.zst');
    expect(store.download).toHaveBeenCalledWith(
      'bkp-1/seamnex-vol-1.tar.zst.age',
      `${archive}.age`,
    );
    expect(age.decrypt).toHaveBeenCalledWith(`${archive}.age`);
    // The volume is re-created under the instance label first: extracting into a name the applied
    // project does not use would lose the data the restore just downloaded.
    expect(docker.ensureVolume).toHaveBeenCalledWith('seamnex-vol-1', {
      'seamnex.instance': 'inst-1',
    });
    expect(String(state.runOrThrow.mock.calls[0]?.[1])).toContain('tar --zstd -xf');
    expect(ctx.lines).toContain('stdout:volume seamnex-vol-1 restored');
    expect(ctx.lines).toContain('stdout:render set none will be applied');
  });

  it('restores data for a backup row that lost its instance reference', async () => {
    const { db, stage } = runner([
      ['SELECT id, slug FROM instance WHERE id = $1', [{ id: '', slug: 'crm' }]],
      [
        'SELECT manifest, instance_id, render_set_id FROM backup WHERE id = $1',
        [
          {
            manifest: { version: 1, services: [], engineDumps: [], volumes: [], includes: [] },
            instance_id: null,
            render_set_id: 'rs-1',
          },
        ],
      ],
      preparing,
      products,
    ]);
    const ctx = context(RESTORE);

    await stage('restore', 0)(ctx);
    await stage('restore', 1)(ctx);

    expect(ctx.lines).toContain('stdout:render set rs-1 will be applied');
    expect(db.calls.some((call) => call.sql.includes("phase = 'products'"))).toBe(true);
  });

  it('names the render set that will be applied', async () => {
    const { stage } = runner([
      INSTANCE,
      [
        'SELECT manifest, instance_id, render_set_id FROM backup WHERE id = $1',
        [
          {
            manifest: { version: 1, services: [], engineDumps: [], volumes: [], includes: [] },
            instance_id: 'inst-1',
            render_set_id: 'rs-1',
          },
        ],
      ],
      preparing,
      products,
    ]);
    const ctx = context({ backupId: 'bkp-1', restoreId: 'run-1' });

    await stage('restore', 0)(ctx);
    await stage('restore', 1)(ctx);

    expect(ctx.lines).toContain('stdout:render set rs-1 will be applied');
    expect(state.runOrThrow).not.toHaveBeenCalled();
  });

  it('refuses to restore data from a backup that is not in the register', async () => {
    const { stage } = runner([
      ['SELECT manifest, instance_id, render_set_id FROM backup WHERE id = $1', []],
    ]);

    await expect(stage('restore', 1)(context())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No backup bkp-1.',
    });
  });

  it('starts the stack from the stored render set and advances to verification', async () => {
    const { db, docker, stage } = runner([
      ['SELECT backup_id FROM restore_run WHERE id = $1', [{ backup_id: 'bkp-1' }]],
      [
        'SELECT render_set_id, instance_id FROM backup WHERE id = $1',
        [{ render_set_id: 'rs-1', instance_id: 'inst-1' }],
      ],
      [
        'SELECT path, content FROM render_file',
        [
          { path: 'a.yml', content: 'x' },
          { path: 'b.yml', content: 'y' },
        ],
      ],
      INSTANCE,
      verifyPhase,
    ]);
    const ctx = context({ backupId: 'bkp-1', restoreId: 'run-1' });
    docker.composeUp.mockImplementationOnce(async (_project, onLine) => {
      await onLine?.('Container seamnex-crm-db-1 Started');
    });

    await stage('restore', 2)(ctx);

    expect(docker.ensureNetwork).toHaveBeenCalledWith('seamnex-inst-crm', {
      'seamnex.instance': 'inst-1',
    });
    // Compose output is streamed into the job log, line by line.
    expect(ctx.lines).toContain('stdout:Container seamnex-crm-db-1 Started');
    const project = docker.composeUp.mock.calls[0]?.[0] as {
      project: string;
      files: string[];
      envFiles: string[];
    };
    expect(project).toMatchObject({ project: 'seamnex-crm' });
    expect(project.files).toHaveLength(2);
    expect(project.envFiles).toHaveLength(1);
    expect(ctx.lines.some((line) => line.includes('render set rs-1 applied with 2 file(s)'))).toBe(
      true,
    );
    expect(db.calls.some((call) => call.sql.includes("phase = 'verify'"))).toBe(true);
  });

  it('reports zero files when the result carries no count', async () => {
    const { docker, stage } = runner([
      ['SELECT backup_id FROM restore_run WHERE id = $1', [{ backup_id: 'bkp-1' }]],
      [
        'SELECT render_set_id, instance_id FROM backup WHERE id = $1',
        [{ render_set_id: 'rs-1', instance_id: 'inst-1' }],
      ],
      [
        'SELECT path, content FROM render_file',
        { rows: [], rowCount: null, command: '', oid: 0, fields: [] },
      ],
      INSTANCE,
      verifyPhase,
    ]);
    const ctx = context({ backupId: 'bkp-1', restoreId: 'run-1' });

    await stage('restore', 2)(ctx);

    expect(ctx.lines.some((line) => line.includes('applied with 0 file(s)'))).toBe(true);
    expect(docker.composeUp).toHaveBeenCalledTimes(1);
  });

  it('refuses when the restore run is not in the register', async () => {
    const { stage } = runner([['SELECT backup_id FROM restore_run WHERE id = $1', []]]);

    await expect(stage('restore', 2)(context(RESTORE))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No restore run run-1.',
    });
  });

  it.each([
    ['no render set', { render_set_id: null, instance_id: 'inst-1' }],
    ['no render set recorded at all', { instance_id: 'inst-1' }],
  ])('refuses a backup with %s', async (_label, row) => {
    const { stage } = runner([
      ['SELECT backup_id FROM restore_run WHERE id = $1', [{ backup_id: 'bkp-1' }]],
      ['SELECT render_set_id, instance_id FROM backup WHERE id = $1', [row]],
    ]);

    await expect(stage('restore', 2)(context(RESTORE))).rejects.toMatchObject({
      code: 'BACKUP_UNUSABLE',
      detail: 'The backup does not reference a render set, so it cannot be restored.',
      remediation: expect.stringContaining('stored definition'),
    });
  });

  it('refuses a backup with no instance to restore into', async () => {
    const { stage } = runner([
      ['SELECT backup_id FROM restore_run WHERE id = $1', [{ backup_id: 'bkp-1' }]],
      ['SELECT render_set_id, instance_id FROM backup WHERE id = $1', [{ render_set_id: 'rs-1' }]],
      ['SELECT path, content FROM render_file', []],
    ]);

    await expect(stage('restore', 2)(context(RESTORE))).rejects.toMatchObject({
      code: 'BACKUP_UNUSABLE',
      detail: 'The backup has no instance to restore into.',
    });
  });

  it('records the completed restore', async () => {
    const { audit, stage } = runner([complete]);
    const ctx = context({ backupId: 'bkp-1', restoreId: 'run-1' });

    await stage('restore', 3)(ctx);

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.restore.succeeded',
        targetId: 'run-1',
        detail: { jobId: 'job-1' },
      }),
    );
  });
});

describe('platform dump stage', () => {
  const manifestWrite: Route = ['UPDATE backup SET manifest = $2::jsonb', []];
  const platformRoutes: Route[] = [manifestWrite];

  function manifestOf(db: ReturnType<typeof runner>['db']): Record<string, unknown> {
    const call = db.calls.find((entry) => entry.sql.includes('UPDATE backup SET manifest'));
    return JSON.parse(String(call?.params[1])) as Record<string, unknown>;
  }

  it('dumps both databases with a 0600 password file that never reaches argv', async () => {
    const seen: { name: string; content: string; mode: number }[] = [];
    state.runOrThrow.mockImplementation(async (_file: string, args: readonly string[]) => {
      const flag = args.find((arg) => arg.startsWith('PGPASSFILE='));
      if (flag !== undefined) {
        const name = flag.replace('PGPASSFILE=/backup/', '');
        const path = join(CONFIG.SEAMNEX_BACKUP_TMP_DIR, 'bkp-p', name);
        seen.push({ name, content: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777 });
      }
      return { code: 0, stdout: '', stderr: '', truncated: false };
    });
    const { stage } = runner(platformRoutes);

    await stage('platform-backup', 0)(context({ backupId: 'bkp-p' }));

    expect(seen).toEqual([
      {
        name: '.pgpass',
        content: '127.0.0.1:5432:seamnex_platform:seamnex:p@ss\n',
        mode: seen[0]?.mode,
      },
      {
        name: '.pgpass-idp',
        content: '127.0.0.1:5432:seamnex_keycloak:keycloak:k@y\n',
        mode: seen[1]?.mode,
      },
    ]);
    if (process.platform !== 'win32') {
      // POSIX is where the check has meaning; a Windows bind mount reports 0666 for everything.
      expect(seen.map((entry) => entry.mode)).toEqual([0o600, 0o600]);
    }
    // Both are removed as soon as their dump returns: the scratch directory outlives the job.
    expect(existsSync(join(CONFIG.SEAMNEX_BACKUP_TMP_DIR, 'bkp-p', '.pgpass'))).toBe(false);
    expect(existsSync(join(CONFIG.SEAMNEX_BACKUP_TMP_DIR, 'bkp-p', '.pgpass-idp'))).toBe(false);
    const [, platformArgs] = state.runOrThrow.mock.calls[0] ?? [];
    expect(platformArgs).toEqual(
      expect.arrayContaining(['pg_dump', '--format=custom', '--file=/backup/platform.dump']),
    );
    expect(platformArgs).toContain('PGDATABASE=seamnex_platform');
    expect(String(platformArgs)).not.toContain('p@ss');
    const [, idpArgs] = state.runOrThrow.mock.calls[1] ?? [];
    expect(idpArgs).toEqual(
      expect.arrayContaining(['pg_dump', '--format=custom', '--file=/backup/idp.dump']),
    );
    expect(idpArgs).toContain('PGDATABASE=seamnex_keycloak');
    expect(String(idpArgs)).not.toContain('k@y');
  });

  it('dumps the platform database at the address the helper can reach, when that differs', async () => {
    // The API talks to `postgres`, the helper cannot resolve that name. `SEAMNEX_PLATFORM_DB_URL` is
    // the same database as the host network sees it, and the refusal trail names whichever setting
    // actually went wrong.
    const { stage } = runner(platformRoutes, {
      SEAMNEX_PLATFORM_DB_URL: 'postgres://seamnex:host-secret@127.0.0.1:55432/seamnex_platform',
    });

    await stage('platform-backup', 0)(context({ backupId: 'bkp-p' }));

    const [, args] = state.runOrThrow.mock.calls[0] ?? [];
    expect(args).toEqual(expect.arrayContaining(['PGPORT=55432', 'PGDATABASE=seamnex_platform']));
    expect(String(args)).not.toContain('host-secret');
  });

  it('hands the daemon the host spelling of every bind source it is given', async () => {
    // The helper is started by the daemon, which reads a bind source on the host filesystem. Where
    // the container path and the host path differ — the dev stack mounts `temp/backups` at
    // `/var/lib/seamnex/backups` — an unmapped source mounts an empty directory, so the dump would
    // be written somewhere this process cannot read.
    const { stage } = runner(platformRoutes, {
      SEAMNEX_DOCKER_PATH_MAP: `${CONFIG.SEAMNEX_BACKUP_TMP_DIR}=/host/backups, ${EDGE_DIR}=/host/edge`,
    });

    await stage('platform-backup', 0)(context({ backupId: 'bkp-p' }));

    const commands = state.runOrThrow.mock.calls.map((call) => String(call[1]));
    const dump = commands.find((args) => args.includes('PGDATABASE=seamnex_platform'));
    // The remainder after the prefix keeps whatever separator the platform uses; the prefix does not.
    expect(dump).toContain('/host/backups');
    expect(dump).toContain('bkp-p:/backup');
    expect(dump).not.toContain(CONFIG.SEAMNEX_BACKUP_TMP_DIR);
    expect(commands.some((args) => args.includes('/host/edge:/src:ro'))).toBe(true);
  });

  it('captures the realm, the edge routes, the audit anchor with its chain head and the catalogue copy', async () => {
    const { keycloak, stage } = runner(platformRoutes);
    const ctx = context({ backupId: 'bkp-p' });

    await stage('platform-backup', 0)(ctx);

    const directory = join(CONFIG.SEAMNEX_BACKUP_TMP_DIR, 'bkp-p');
    expect(keycloak.exportRealm).toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(directory, 'realm.json'), 'utf8'))).toEqual({
      realm: 'seamnex',
    });
    // The agent archives with a helper rather than walking the trees in the API process.
    const commands = state.runOrThrow.mock.calls.map((call) => String(call[1]));
    expect(commands.some((args) => args.includes(`${EDGE_DIR}:/src:ro`))).toBe(true);
    expect(commands.some((args) => args.includes(`${CATALOG_DIR}:/src:ro`))).toBe(true);
    expect(commands.some((args) => args.includes('edge-routes.tar.gz'))).toBe(true);
    expect(commands.some((args) => args.includes('catalog.tar.gz'))).toBe(true);
    const anchor = JSON.parse(readFileSync(join(directory, 'audit-anchor.json'), 'utf8')) as {
      anchors: unknown[];
      chainHead: { seq: string; hash: string };
    };
    expect(anchor.anchors).toHaveLength(1);
    expect(anchor.chainHead).toMatchObject({ seq: '42', hash: 'b'.repeat(64) });
    expect(ctx.lines).toContain('stdout:identity-provider database dumped to idp.dump');
  });

  it('writes a manifest that claims nothing before the upload stage', async () => {
    const { db, age, stage } = runner(platformRoutes);

    await stage('platform-backup', 0)(context({ backupId: 'bkp-p' }));

    const manifest = manifestOf(db) as {
      version: number;
      includes: string[];
      artefacts: {
        kind: string;
        included: boolean;
        objectKey: string | null;
        location: string | null;
      }[];
      encryption: { recipient: string };
      rootKeyId: string | null;
    };
    expect(manifest.version).toBe(2);
    // Nothing has been uploaded yet, so the set claims nothing — not even the parts it wrote.
    expect(manifest.includes).toEqual([]);
    expect(manifest.artefacts.map((artefact) => artefact.kind)).toEqual([
      'platform_database',
      'idp_database',
      'idp_realm',
      'edge_routes',
      'audit_anchor',
      'catalog_repo',
      'edge_static_and_tls',
      'secret_root_key',
    ]);
    expect(manifest.artefacts.every((artefact) => !artefact.included)).toBe(true);
    expect(manifest.artefacts.every((artefact) => artefact.objectKey === null)).toBe(true);
    expect(manifest.artefacts[6]).toMatchObject({ location: 'vault://edge/ingress-tls' });
    expect(manifest.artefacts[7]).toMatchObject({ location: 'vault://platform/root-key' });
    expect(manifest.encryption.recipient).toBe(age.recipientId());
    // The key's identifier, never the key: 16 hex characters hashed from the file.
    expect(manifest.rootKeyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('says so when an operator-owned artefact has no recorded location', async () => {
    const { stage } = runner(platformRoutes, { SEAMNEX_ROOT_KEY_ESCROW_REF: '' });
    const ctx = context({ backupId: 'bkp-p' });

    await stage('platform-backup', 0)(ctx);

    expect(ctx.lines).toContain(
      'system:operator-owned artefacts with no recorded location: secret_root_key',
    );
  });

  it('refuses before writing anything when the identity-provider database is not configured', async () => {
    const { stage } = runner(platformRoutes, { SEAMNEX_KEYCLOAK_DB_URL: '' });

    await expect(stage('platform-backup', 0)(context({ backupId: 'bkp-p' }))).rejects.toMatchObject(
      {
        code: 'ADAPTER_UNAVAILABLE',
        detail: expect.stringContaining('SEAMNEX_KEYCLOAK_DB_URL'),
        remediation: expect.stringContaining('identity provider'),
      },
    );
    expect(state.runOrThrow).not.toHaveBeenCalled();
  });

  it('reports every missing prerequisite in one refusal instead of one per run', async () => {
    const { stage } = runner(platformRoutes, {
      SEAMNEX_KEYCLOAK_DB_URL: '',
      SEAMNEX_AGE_RECIPIENT: '',
    });

    const error = await stage(
      'platform-backup',
      0,
    )(context({ backupId: 'bkp-p' })).catch((thrown: unknown) => thrown);

    // An operator who fixes one item and waits through two dumps to learn the next is the defect this
    // message exists to prevent, so both settings appear in the sentence the console renders.
    expect(error).toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringMatching(/SEAMNEX_KEYCLOAK_DB_URL[\s\S]*SEAMNEX_AGE_RECIPIENT/),
    });
    expect((error as AppError).detail).toContain('take the backup again');
    expect(state.runOrThrow).not.toHaveBeenCalled();
  });

  it('refuses when the edge route directory is absent', async () => {
    rmSync(EDGE_DIR, { recursive: true, force: true });
    const { stage } = runner(platformRoutes);

    await expect(stage('platform-backup', 0)(context({ backupId: 'bkp-p' }))).rejects.toMatchObject(
      {
        code: 'ADAPTER_UNAVAILABLE',
        detail: expect.stringContaining('SEAMNEX_TRAEFIK_DYNAMIC_DIR'),
      },
    );
    expect(state.runOrThrow).not.toHaveBeenCalled();
  });

  it('refuses when the catalogue tree is absent', async () => {
    rmSync(CATALOG_DIR, { recursive: true, force: true });
    const { stage } = runner(platformRoutes);

    await expect(stage('platform-backup', 0)(context({ backupId: 'bkp-p' }))).rejects.toMatchObject(
      {
        code: 'ADAPTER_UNAVAILABLE',
        detail: expect.stringContaining('SEAMNEX_CATALOG_REPO_PATH'),
      },
    );
    expect(state.runOrThrow).not.toHaveBeenCalled();
  });

  it('defaults the port and the database name a URL may omit', async () => {
    const { stage } = runner(platformRoutes, {
      DATABASE_URL: 'postgres://seamnex@localhost/',
      SEAMNEX_KEYCLOAK_DB_URL: 'postgres://keycloak@localhost/',
    });

    await stage('platform-backup', 0)(context({ backupId: 'bkp-q' }));

    const [, args] = state.runOrThrow.mock.calls[0] ?? [];
    expect(args).toContain('PGPORT=5432');
    expect(args).toContain('PGDATABASE=postgres');
  });

  it('passes the helper an environment even when the API has no PATH', async () => {
    vi.stubEnv('PATH', undefined);
    const { stage } = runner(platformRoutes);
    try {
      await stage('platform-backup', 0)(context({ backupId: 'bkp-p' }));

      const [, , options] = state.runOrThrow.mock.calls[0] ?? [];
      expect(options).toMatchObject({ env: { PATH: '' }, timeoutMs: 900_000 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses a database URL the dump container cannot reach', async () => {
    const { stage } = runner(platformRoutes, {
      DATABASE_URL: 'postgres://seamnex:secret@postgres:5432/seamnex_platform',
    });

    await expect(stage('platform-backup', 0)(context({ backupId: 'bkp-p' }))).rejects.toMatchObject(
      {
        code: 'ADAPTER_UNAVAILABLE',
        detail: expect.stringContaining('"postgres"'),
        remediation: expect.stringContaining('published localhost address'),
      },
    );
    expect(state.runOrThrow).not.toHaveBeenCalled();
  });
});

describe('platform upload stage', () => {
  const stateWrite: Route = ['UPDATE backup SET state = ', []];

  /** The manifest a completed capture leaves behind, with every captured file present on disk. */
  function capturedManifest(backupId: string) {
    const capturedAt = '2026-11-15T10:02:00.000Z';
    const artefacts = [
      plannedArtefact('platform_database', capturedAt),
      plannedArtefact('idp_database', capturedAt),
      plannedArtefact('idp_realm', capturedAt),
      plannedArtefact('edge_routes', capturedAt),
      plannedArtefact('audit_anchor', capturedAt),
      plannedArtefact('catalog_repo', capturedAt),
      referenceArtefact('edge_static_and_tls', 'vault://edge/ingress-tls', capturedAt),
      referenceArtefact('secret_root_key', 'vault://platform/root-key', capturedAt),
    ];
    const directory = join(CONFIG.SEAMNEX_BACKUP_TMP_DIR, backupId);
    mkdirSync(directory, { recursive: true });
    for (const file of [
      'platform.dump',
      'idp.dump',
      'realm.json',
      'edge-routes.tar.gz',
      'audit-anchor.json',
      'catalog.tar.gz',
    ]) {
      writeFileSync(join(directory, file), `plaintext:${file}`);
    }
    return createPlatformManifest({
      artefacts,
      encryption: { recipient: 'age1recipient', identityId: 'escrowed' },
      rootKeyId: 'ab'.repeat(8),
      capturedAt,
    });
  }

  it('uploads every captured artefact with a content digest and only then claims the set', async () => {
    const backupId = 'bkp-u';
    const manifest = capturedManifest(backupId);
    const { audit, db, stage, store } = runner([
      ['SELECT manifest FROM backup WHERE id = $1', [{ manifest }]],
      stateWrite,
    ]);
    const ctx = context({ backupId });

    await stage('platform-backup', 1)(ctx);

    expect(store.putFile).toHaveBeenCalledTimes(6);
    const keys = store.putFile.mock.calls.map((call) => call[0]);
    expect(keys).toEqual([
      `${backupId}/platform.dump.age`,
      `${backupId}/idp.dump.age`,
      `${backupId}/realm.json.age`,
      `${backupId}/edge-routes.tar.gz.age`,
      `${backupId}/audit-anchor.json.age`,
      `${backupId}/catalog.tar.gz.age`,
    ]);
    // The digest is of the stored bytes, not of the key and the size.
    const stored = store.putFile.mock.calls.map((call) => call[1] as string);
    expect(stored[0]).toBe(join(CONFIG.SEAMNEX_BACKUP_TMP_DIR, backupId, 'platform.dump.age'));

    const update = db.calls.find((call) => call.sql.includes('UPDATE backup SET state = '));
    expect(update?.params[1]).toBe(600);
    expect(update?.params[2]).toBe(`${backupId}/manifest.json`);
    const written = update?.params[3] as string;
    const finalManifest = JSON.parse(written) as {
      includes: string[];
      artefacts: { kind: string; included: boolean; digest: string | null; bytes: number | null }[];
    };
    expect(finalManifest.includes).toEqual([
      'platform_database',
      'idp_database',
      'idp_realm',
      'edge_routes',
      'audit_anchor',
      'catalog_repo',
    ]);
    expect(finalManifest.artefacts[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
    // The manifest is uploaded as its own object, in the same shape the row now carries.
    const [manifestKey, manifestBody] = store.putText.mock.calls[0] ?? [];
    expect(manifestKey).toBe(`${backupId}/manifest.json`);
    expect(JSON.parse(String(manifestBody))).toEqual(finalManifest);
    // The operator-owned entries keep `included: false`; nothing was uploaded for them.
    expect(finalManifest.artefacts[6]).toMatchObject({ included: false, bytes: null });
    expect(finalManifest.artefacts[7]).toMatchObject({ included: false, bytes: null });
    // Plaintext and the local encrypted copy both go: the object store is the durable location.
    expect(existsSync(join(CONFIG.SEAMNEX_BACKUP_TMP_DIR, backupId, 'realm.json'))).toBe(false);
    expect(existsSync(join(CONFIG.SEAMNEX_BACKUP_TMP_DIR, backupId, 'realm.json.age'))).toBe(false);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.backup.succeeded',
        detail: {
          bytes: 600,
          artefacts: 6,
          referenced: ['edge_static_and_tls', 'secret_root_key'],
        },
      }),
    );
    expect(ctx.lines).toContain('system:platform backup uploaded (600 bytes, 6 artefacts)');
  });

  it('refuses a set whose capture manifest is missing or not readable', async () => {
    const { db, stage, store } = runner([
      [
        'SELECT manifest FROM backup WHERE id = $1',
        [{ manifest: { version: 1, includes: ['platform_database', 'realm'] } }],
      ],
    ]);

    await expect(stage('platform-backup', 1)(context({ backupId: 'bkp-p' }))).rejects.toMatchObject(
      {
        code: 'BACKUP_UNUSABLE',
        detail: expect.stringContaining('no readable capture manifest'),
      },
    );
    expect(store.putFile).not.toHaveBeenCalled();
    expect(db.calls.some((call) => call.sql.includes("state = 'succeeded'"))).toBe(false);
  });

  it('leaves the set unclaimed when an upload fails halfway', async () => {
    const backupId = 'bkp-half';
    const manifest = capturedManifest(backupId);
    const { db, stage, store } = runner([
      ['SELECT manifest FROM backup WHERE id = $1', [{ manifest }]],
      stateWrite,
    ]);
    store.putFile.mockRejectedValueOnce(new Error('the object store is unreachable'));

    await expect(stage('platform-backup', 1)(context({ backupId }))).rejects.toThrow(
      'the object store is unreachable',
    );
    expect(db.calls.some((call) => call.sql.includes("state = 'succeeded'"))).toBe(false);
    expect(store.putText).not.toHaveBeenCalled();
  });

  it('refuses to call an artefact included when the stored object is empty', async () => {
    const backupId = 'bkp-empty';
    const manifest = capturedManifest(backupId);
    const { db, stage, store } = runner([
      ['SELECT manifest FROM backup WHERE id = $1', [{ manifest }]],
      stateWrite,
    ]);
    store.putFile.mockResolvedValue({ key: `${backupId}/platform.dump.age`, bytes: 0 });

    await expect(stage('platform-backup', 1)(context({ backupId }))).rejects.toThrow(
      /stored with no bytes/,
    );
    expect(db.calls.some((call) => call.sql.includes("state = 'succeeded'"))).toBe(false);
  });
});

describe('platform restore phases', () => {
  it('restores the identity provider first', async () => {
    const { db, docker, stage } = runner([['UPDATE restore_run SET phase = $2', []]]);

    await stage('platform-restore', 0)(context({ backupId: 'bkp-p', restoreId: 'run-1' }));

    expect(db.calls[0]?.params).toEqual(['run-1', 'idp']);
    expect(docker.containers).not.toHaveBeenCalled();
  });

  it('stops every running product and remembers the ids it stopped', async () => {
    const { db, docker, stage } = runner([
      ['UPDATE restore_run SET phase = $2', []],
      [
        'SELECT id, slug FROM instance WHERE deleted_at IS NULL',
        [{ id: 'inst-1' }, { id: 'inst-2' }],
      ],
      ['UPDATE restore_run SET detail = detail || jsonb_build_object', []],
    ]);
    docker.containers.mockImplementation(async (labels: readonly string[]) =>
      labels[0] === 'seamnex.instance=inst-1'
        ? [
            { id: 'c1', state: 'running' },
            { id: 'c2', state: 'exited' },
          ]
        : [],
    );
    const ctx = context({ backupId: 'bkp-p', restoreId: 'run-1' });

    await stage('platform-restore', 1)(ctx);

    expect(docker.stop.mock.calls).toEqual([['c1', 15]]);
    const detail = db.calls.find((call) => call.sql.includes('jsonb_build_object'));
    expect(detail?.params).toEqual(['run-1', '["c1"]']);
    expect(ctx.lines).toContain('stdout:stopped 1 container(s) across 2 instance(s)');
  });

  it('holds the gate and says a login is what releases it', async () => {
    const { db, stage } = runner([
      ['UPDATE restore_run SET phase = $2', []],
      ['awaitingLogin', []],
    ]);
    const ctx = context({ backupId: 'bkp-p', restoreId: 'run-1' });

    await stage('platform-restore', 2)(ctx);

    expect(db.calls.some((call) => call.sql.includes('awaitingLogin'))).toBe(true);
    expect(ctx.lines.some((line) => line.includes('holding the gate'))).toBe(true);
  });
});

describe('settling a failed platform job', () => {
  const settleBackup: Route = ['UPDATE backup', []];
  const settleRestore: Route = ['UPDATE restore_run', []];

  it('records the AppError code and its message on the capture row', async () => {
    const { db, audit, pipelines } = runner([settleBackup]);
    const handler = pipelines.failureHandler('platform-backup');
    const ctx = context({ backupId: 'bkp-p' });

    await handler?.(ctx, new AppError({ code: 'ADAPTER_UNAVAILABLE', detail: 'docker is down' }));

    expect(db.calls[0]?.params).toEqual(['bkp-p', 'ADAPTER_UNAVAILABLE', 'docker is down']);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.backup.failed',
        outcome: 'failure',
        detail: { code: 'ADAPTER_UNAVAILABLE', message: 'docker is down', jobId: 'job-1' },
      }),
    );
  });

  it('keeps no scratch copy of a set that failed', async () => {
    const { pipelines } = runner([settleBackup]);
    const directory = join(CONFIG.SEAMNEX_BACKUP_TMP_DIR, 'bkp-p');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'realm.json'), '{"clients":[{"secret":"s3cr3t"}]}');

    await pipelines.failureHandler('platform-backup')?.(
      context({ backupId: 'bkp-p' }),
      new AppError({ code: 'BACKUP_FAILED', detail: 'the upload died' }),
    );

    // The directory held a dump and an unencrypted realm export; a retry is another capture.
    expect(existsSync(directory)).toBe(false);
  });

  it('falls back to BACKUP_FAILED for an error that is not an AppError', async () => {
    const { db, pipelines } = runner([settleBackup]);
    const ctx = context({ backupId: 'bkp-p' });

    await pipelines.failureHandler('platform-backup')?.(ctx, new Error('age exited with 1'));

    expect(db.calls[0]?.params).toEqual(['bkp-p', 'BACKUP_FAILED', 'age exited with 1']);
  });

  it('states that the capture did not finish when there is no cause at all', async () => {
    const { db, pipelines } = runner([settleBackup]);

    await pipelines.failureHandler('platform-backup')?.(context({ backupId: 'bkp-p' }));

    expect(db.calls[0]?.params).toEqual(['bkp-p', 'BACKUP_FAILED', 'the capture did not finish']);
  });

  it('records the failure and its phase on the restore run', async () => {
    const { db, audit, pipelines } = runner([settleRestore]);
    const ctx = context({ backupId: 'bkp-p', restoreId: 'run-1' });

    await pipelines.failureHandler('platform-restore')?.(ctx, new Error('realm export rejected'));

    expect(db.calls[0]?.params).toEqual(['run-1', 'realm export rejected']);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.restore.failed',
        targetId: 'run-1',
        detail: { message: 'realm export rejected', jobId: 'job-1' },
      }),
    );
  });

  it('states that the restore did not finish when there is no cause', async () => {
    const { db, pipelines } = runner([settleRestore]);

    await pipelines.failureHandler('platform-restore')?.(context({ restoreId: 'run-1' }));

    expect(db.calls[0]?.params).toEqual(['run-1', 'the restore did not finish']);
  });
});
