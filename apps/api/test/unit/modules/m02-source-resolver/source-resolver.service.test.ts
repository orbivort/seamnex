import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { FilesystemSourceResolver } from '../../../../src/modules/m02-source-resolver/source-resolver.service';

/**
 * 4A.2 — the source precedence and what each branch refuses to guess.
 *
 * The tree is a real temp directory (the service *is* a filesystem adapter: a fake fs would test the
 * fake) and git is the only stubbed seam, because cloning is the one thing a unit test cannot do
 * deterministically. The assertions are about the decisions: Compose wins over Dockerfile, a
 * vendored mirror wins over the network, a blocked compose file fails before a job starts and names
 * the service, and nothing is persisted for a resolution that was refused.
 */
const h = vi.hoisted(() => ({ cloneAtRevision: vi.fn() }));
vi.mock('../../../../src/common/exec/git', () => ({ cloneAtRevision: h.cloneAtRevision }));

const ENTRY = 'SELECT key, repo_url, packaging, payload FROM catalog_entry';
const DRAFT = 'approved_at IS NOT NULL';
const WAIVED = 'FROM policy_exception';
const INSERT_FILE = 'INSERT INTO source_file';
const INSERT_RESOLUTION = 'INSERT INTO source_resolution';
const CONFIRM_SELECT = 'created_at, approved_by FROM scaffold_artefact';
const LATEST_SELECT = 'approved_by, created_at FROM scaffold_artefact';
const UPDATE_SCAFFOLD = 'UPDATE scaffold_artefact';
const TOUCH_ENTRY = 'UPDATE catalog_entry SET updated_at';

type Config = {
  SEAMNEX_INSTANCE_DATA_DIR: string;
  SEAMNEX_CATALOG_REPO_PATH: string;
  SEAMNEX_SOURCE_MIRROR_DIR: string;
  sourceAllowedHosts: string[];
};

type SetupOptions = {
  entry?: Record<string, unknown>[];
  draft?: Record<string, unknown>[];
  waived?: Record<string, unknown>[];
  resolution?: Record<string, unknown>[];
  confirm?: Record<string, unknown>[];
  latest?: Record<string, unknown>[];
};

/** The shape the resolver hands to the audit chain; read back to compare the recorded sha. */
type AuditInput = { action: string; readonly detail?: Record<string, unknown> };

const roots: string[] = [];

function entryRow(overrides: Record<string, unknown> = {}) {
  return { key: 'D01-01', repo_url: null, packaging: 'compose', payload: {}, ...overrides };
}

function document(overrides: Record<string, unknown> = {}) {
  return {
    key: 'D01-01',
    domain: 'collaboration',
    cluster: 'Core Operations',
    product: 'EspoCRM',
    description: 'CRM',
    repoUrl: 'https://git.example.test/espocrm.git',
    licenseId: 'AGPL-3.0',
    stack: 'php',
    imageRef: 'espocrm/espocrm:8.0.0',
    imageDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    upstream: {
      currentVersion: '8.0.0',
      latestVersion: '8.0.0',
      advisory: null,
      releaseUrl: 'https://git.example.test/espocrm/releases/8.0.0',
      checkedAt: '2026-01-01T00:00:00.000Z',
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
      verifiedAt: '2026-01-01T00:00:00.000Z',
      nextReviewAt: '2026-04-01T00:00:00.000Z',
      stale: false,
    },
    owner: { name: 'Team', team: 'core' },
    notes: 'notes',
    verifiedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const DRAFT_FILES = [
  { path: 'Dockerfile', language: 'dockerfile', content: 'FROM alpine:3.20\n' },
  { path: 'app/compose.yaml', language: 'yaml', content: 'services: {}\n' },
];

function setup(options: SetupOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'seamnex-m02-'));
  roots.push(root);
  const instanceData = join(root, 'instances');
  const catalogRepo = join(root, 'catalog-repo');
  mkdirSync(instanceData, { recursive: true });
  mkdirSync(catalogRepo, { recursive: true });

  const db = fakeDb([
    [ENTRY, options.entry ?? []],
    [DRAFT, options.draft ?? []],
    [WAIVED, options.waived ?? []],
    [INSERT_FILE, []],
    [INSERT_RESOLUTION, options.resolution ?? [{ id: 'res-1' }]],
    [CONFIRM_SELECT, options.confirm ?? []],
    [LATEST_SELECT, options.latest ?? []],
    [UPDATE_SCAFFOLD, []],
    [TOUCH_ENTRY, []],
  ]);
  const audit = {
    lockChain: vi.fn(async (_tx: unknown) => undefined),
    append: vi.fn(async (_input: AuditInput) => ({ seq: '1', hash: 'h' })),
  };
  const catalog = {
    load: vi.fn(),
    recordDrift: vi.fn(),
    recordCommit: vi.fn(async () => undefined),
  };
  const config: Config = {
    SEAMNEX_INSTANCE_DATA_DIR: instanceData,
    SEAMNEX_CATALOG_REPO_PATH: catalogRepo,
    SEAMNEX_SOURCE_MIRROR_DIR: '',
    sourceAllowedHosts: ['git.example.test'],
  };
  const service = new FilesystemSourceResolver(
    config as unknown as AppConfig,
    db.pool,
    audit as never,
    catalog as never,
  );
  return { db, audit, catalog, config, instanceData, catalogRepo, root, service };
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

/** The vendored tree the resolver prefers over the network, at its default location. */
function mirrorTree(catalogRepo: string, files: Record<string, string>): string {
  const source = join(catalogRepo, 'upstream', 'D01-01');
  mkdirSync(source, { recursive: true });
  writeTree(source, files);
  return source;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const COMPOSE = `services:
  app:
    image: espocrm/espocrm:8.0.0
    expose:
      - '80'
`;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolve — source path precedence', () => {
  it('applies the compose file first and retains the env sample beside it', async () => {
    const { db, catalogRepo, service } = setup({ entry: [entryRow({ payload: document() })] });
    mirrorTree(catalogRepo, {
      SOURCE_REVISION: 'rev-from-mirror\n',
      'docker-compose.yml': COMPOSE,
      '.env.example': 'APP_KEY=\n',
    });
    const progress = vi.fn(async () => undefined);

    const resolved = await service.resolve({
      instanceId: 'inst-1',
      entryKey: 'D01-01',
      onProgress: progress,
    });

    expect(resolved).toMatchObject({
      resolutionId: 'res-1',
      path: 'compose',
      sourceUrl: 'mirror://D01-01',
      revision: 'rev-from-mirror',
      imageRef: 'espocrm/espocrm:8.0.0',
      imageDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      dockerfilePath: null,
      policy: { verdict: 'allowed', publishedPorts: 0 },
    });
    expect(resolved.composeFile).toMatch(/docker-compose\.yml$/);
    // Only the compose file and the env samples are retained — not the whole repository.
    expect(resolved.files.map((file) => file.path)).toEqual(['docker-compose.yml', '.env.example']);
    expect(resolved.files[0]?.content).toBe(COMPOSE);
    expect(resolved.files[1]?.sha256).toBe(sha256('APP_KEY=\n'));
    expect(progress).toHaveBeenCalledWith('source path resolved: compose at rev-from-mir');

    const resolution = db.calls.find((call) => call.sql.includes(INSERT_RESOLUTION));
    expect(resolution?.params).toEqual([
      'inst-1',
      'compose',
      'mirror://D01-01',
      'rev-from-mirror',
      'espocrm/espocrm:8.0.0',
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      'allowed',
    ]);
    const files = db.calls.filter((call) => call.sql.includes(INSERT_FILE));
    expect(files.map((call) => call.params)).toEqual([
      ['res-1', 'docker-compose.yml', sha256(COMPOSE), COMPOSE],
      ['res-1', '.env.example', sha256('APP_KEY=\n'), 'APP_KEY=\n'],
    ]);
  });

  it('finds a compose file under its last documented name', async () => {
    const { catalogRepo, service } = setup({ entry: [entryRow({ payload: document() })] });
    mirrorTree(catalogRepo, { 'compose.yaml': COMPOSE, 'env.example': 'A=1\n' });

    const resolved = await service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' });

    expect(resolved.composeFile).toMatch(/compose\.yaml$/);
    expect(resolved.files.map((file) => file.path)).toEqual(['compose.yaml', 'env.example']);
  });

  it('falls back to a Dockerfile when the tree has no compose file', async () => {
    const { db, catalogRepo, service } = setup({ entry: [entryRow({ payload: document() })] });
    mirrorTree(catalogRepo, {
      SOURCE_REVISION: 'rev-from-mirror\n',
      'docker/Dockerfile': 'FROM alpine:3.20\n',
    });

    const resolved = await service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' });

    expect(resolved).toMatchObject({
      path: 'dockerfile',
      composeFile: null,
      imageRef: 'seamnex/instance-inst-1:rev-from-mir',
      imageDigest: null,
      policy: { verdict: 'allowed', violations: [] },
    });
    expect(resolved.dockerfilePath).toMatch(/docker[\\/]Dockerfile$/);
    expect(resolved.files.map((file) => file.path)).toEqual(['docker/Dockerfile']);
    // The build produces a platform-tagged image, so the recorded verdict is the neutral one.
    const resolution = db.calls.find((call) => call.sql.includes(INSERT_RESOLUTION));
    expect(resolution?.params.slice(1, 3)).toEqual(['dockerfile', 'mirror://D01-01']);
    expect(resolution?.params[6]).toBe('allowed');
  });

  it('writes an approved scaffold into the attempt directory when the tree has neither', async () => {
    const { db, service } = setup({
      entry: [entryRow()],
      draft: [{ id: 'draft-1', files: DRAFT_FILES }],
    });

    const resolved = await service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' });

    // Nothing in the document declares an image, so there is none to record.
    expect(resolved).toMatchObject({
      path: 'scaffold',
      composeFile: null,
      dockerfilePath: null,
      imageRef: null,
      imageDigest: null,
    });
    expect(resolved.files).toEqual(
      DRAFT_FILES.map((file) => ({
        path: file.path,
        sha256: sha256(file.content),
        content: file.content,
      })),
    );
    expect(readFileSync(join(resolved.directory, 'Dockerfile'), 'utf8')).toBe('FROM alpine:3.20\n');
    expect(
      db.calls.filter((call) => call.sql.includes(INSERT_FILE)).map((call) => call.params),
    ).toEqual(DRAFT_FILES.map((file) => ['res-1', file.path, sha256(file.content), file.content]));
  });

  it('refuses an entry with no compose file, no Dockerfile and no approved scaffold', async () => {
    const { db, service } = setup({ entry: [entryRow()] });

    await expect(
      service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'D01-01 has no Compose file, no Dockerfile and no approved scaffold.',
      remediation: 'Generate a scaffold draft for the entry, approve it, then deploy again.',
    });
    expect(db.calls.some((call) => call.sql.includes(INSERT_RESOLUTION))).toBe(false);
  });

  it('treats a draft whose files do not satisfy the contract as no draft at all', async () => {
    const { service } = setup({
      entry: [entryRow()],
      draft: [{ id: 'draft-1', files: [{ path: 'Dockerfile' }] }],
    });

    await expect(
      service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses an unknown entry before touching the instance directory', async () => {
    const { service } = setup();

    await expect(
      service.resolve({ instanceId: 'inst-1', entryKey: 'D09-01' }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No catalog entry D09-01.',
      remediation: 'Reload the catalog repository and check the entry key.',
    });
  });
});

describe('resolve — fetching the tree', () => {
  it('prefers the vendored mirror over the network', async () => {
    const { catalogRepo, service } = setup({ entry: [entryRow({ payload: document() })] });
    mirrorTree(catalogRepo, {
      SOURCE_REVISION: 'rev-from-mirror\n',
      'docker-compose.yml': COMPOSE,
    });

    const resolved = await service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' });

    // Nothing was cloned: the payload names a repository, and the mirror still won.
    expect(h.cloneAtRevision).not.toHaveBeenCalled();
    expect(resolved.revision).toBe('rev-from-mirror');
    expect(resolved.sourceUrl).toBe('mirror://D01-01');
  });

  it('derives the mirror revision from the tree content when no SOURCE_REVISION is vendored', async () => {
    const { catalogRepo, service } = setup({ entry: [entryRow()] });
    const source = mirrorTree(catalogRepo, { 'docker-compose.yml': COMPOSE });
    writeTree(source, { 'nested/README.md': 'hello\n' });

    const resolved = await service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' });

    expect(resolved.revision).toMatch(/^mirror-[0-9a-f]{12}$/);
    expect(resolved.composeFile).toMatch(/docker-compose\.yml$/);
  });

  it('ignores a SOURCE_REVISION whose first line is blank and hashes the tree instead', async () => {
    const { catalogRepo, service } = setup({ entry: [entryRow()] });
    mirrorTree(catalogRepo, { SOURCE_REVISION: '\r\nabc123\n', 'docker-compose.yml': COMPOSE });

    const resolved = await service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' });

    expect(resolved.revision).toMatch(/^mirror-[0-9a-f]{12}$/);
  });

  it('honours SEAMNEX_SOURCE_MIRROR_DIR when it is set', async () => {
    const { config, root, service } = setup({ entry: [entryRow()] });
    const custom = join(root, 'vendored');
    config.SEAMNEX_SOURCE_MIRROR_DIR = custom;
    mkdirSync(join(custom, 'D01-01'), { recursive: true });
    writeTree(join(custom, 'D01-01'), { SOURCE_REVISION: 'pinned-rev\n', 'compose.yml': COMPOSE });

    const resolved = await service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' });

    expect(resolved.revision).toBe('pinned-rev');
    expect(resolved.composeFile).toMatch(/compose\.yml$/);
  });

  it('clones the payload repository at the default branch head', async () => {
    const { db, service } = setup({
      entry: [entryRow({ payload: document() })],
      draft: [{ id: 'draft-1', files: DRAFT_FILES }],
    });
    h.cloneAtRevision.mockResolvedValue({ commit: 'commit-abc123456789', revision: 'HEAD' });

    const resolved = await service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' });

    const options = h.cloneAtRevision.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).toMatchObject({
      url: 'https://git.example.test/espocrm.git',
      allowedHosts: ['git.example.test'],
      timeoutMs: 300_000,
    });
    // No revision named: the option is omitted rather than sent as `undefined`.
    expect(Object.hasOwn(options, 'revision')).toBe(false);
    expect(resolved).toMatchObject({
      path: 'scaffold',
      sourceUrl: 'https://git.example.test/espocrm.git',
      revision: 'commit-abc123456789',
    });
    expect(db.calls.find((call) => call.sql.includes(INSERT_RESOLUTION))?.params[3]).toBe(
      'commit-abc123456789',
    );
  });

  it('clones the revision the caller named', async () => {
    const { service } = setup({
      entry: [entryRow({ repo_url: 'https://git.example.test/legacy.git', packaging: 'compose' })],
      draft: [{ id: 'draft-1', files: DRAFT_FILES }],
    });
    h.cloneAtRevision.mockResolvedValue({ commit: 'commit-def456789012', revision: 'v1.2.3' });

    await service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01', revision: 'v1.2.3' });

    // The payload does not parse, so the column is the authority for the URL.
    expect(h.cloneAtRevision.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://git.example.test/legacy.git',
      revision: 'v1.2.3',
    });
  });

  it('resolves the local tree when the payload does not parse and the column names no repository', async () => {
    const { service } = setup({
      entry: [entryRow({ repo_url: null })],
      draft: [{ id: 'draft-1', files: DRAFT_FILES }],
    });

    const resolved = await service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' });

    expect(h.cloneAtRevision).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({ sourceUrl: null, revision: 'local', path: 'scaffold' });
  });

  it('resolves the local tree when the column URL is empty', async () => {
    const { service } = setup({
      entry: [entryRow({ repo_url: '', packaging: 'compose' })],
      draft: [{ id: 'draft-1', files: DRAFT_FILES }],
    });

    const resolved = await service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' });

    expect(h.cloneAtRevision).not.toHaveBeenCalled();
    expect(resolved.revision).toBe('local');
  });

  it('resolves the local tree for an entry packaged as "none", whatever the URL says', async () => {
    const { service } = setup({
      entry: [entryRow({ repo_url: 'https://git.example.test/espocrm.git', packaging: 'none' })],
      draft: [{ id: 'draft-1', files: DRAFT_FILES }],
    });

    const resolved = await service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' });

    expect(h.cloneAtRevision).not.toHaveBeenCalled();
    expect(resolved.sourceUrl).toBeNull();
  });

  it('reports a local resolution as such in the job log', async () => {
    const { service } = setup({
      entry: [entryRow()],
      draft: [{ id: 'draft-1', files: DRAFT_FILES }],
    });
    const progress = vi.fn(async () => undefined);

    await service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01', onProgress: progress });

    expect(progress).toHaveBeenCalledWith('source path resolved: scaffold (local tree)');
  });
});

describe('resolve — upstream failures', () => {
  it.each([
    'source host evil.test is not allow-listed (allowed: git.example.test)',
    'source URL must use https (got http)',
    'source host 10.0.0.5 is a private address',
  ])('refuses an upstream the git guard rejected: %s', async (message) => {
    const { db, service } = setup({ entry: [entryRow({ payload: document() })] });
    h.cloneAtRevision.mockRejectedValue(new Error(message));

    await expect(
      service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' }),
    ).rejects.toMatchObject({
      code: 'SOURCE_URL_REJECTED',
      detail: `The source URL for D01-01 was refused: ${message}`,
      remediation:
        'Put the repository on an allow-listed host (git.example.test), or add it to SEAMNEX_SOURCE_ALLOWED_HOSTS.',
    });
    expect(db.calls.some((call) => call.sql.includes(INSERT_RESOLUTION))).toBe(false);
  });

  it('reports an unreachable upstream as unavailable, keeping the cause', async () => {
    const { service } = setup({ entry: [entryRow({ payload: document() })] });
    const cause = new Error('connection timed out');
    h.cloneAtRevision.mockRejectedValue(cause);

    const failure = service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' });

    await expect(failure).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      detail: 'The source repository for D01-01 could not be fetched: connection timed out',
      remediation: 'Check the repository URL and the host network, then retry the deployment.',
      cause,
    });
  });

  it('describes a non-Error rejection without crashing on it', async () => {
    const { service } = setup({ entry: [entryRow({ payload: document() })] });
    h.cloneAtRevision.mockRejectedValue('git exited 128');

    await expect(
      service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' }),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      detail: 'The source repository for D01-01 could not be fetched: git exited 128',
    });
  });
});

describe('resolve — compose policy', () => {
  const BLOCKED = `services:
  app:
    image: espocrm/espocrm:8.0.0
    privileged: true
networks:
  legacy:
    external: true
`;

  it('refuses a compose file that breaks the policy, naming the service and recording the refusal', async () => {
    const { audit, db, catalogRepo, service } = setup({ entry: [entryRow()] });
    mirrorTree(catalogRepo, { 'docker-compose.yml': BLOCKED });

    const failure = service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' });

    await expect(failure).rejects.toMatchObject({
      code: 'COMPOSE_POLICY_BLOCKED',
      detail:
        'The compose file is refused by the platform policy: service app requests privileged mode. network legacy is declared external.',
      remediation:
        'Remove the offending key, or record an approved policy exception before the next deployment.',
      fieldErrors: [
        { field: 'app', code: 'privileged', message: 'service app requests privileged mode.' },
        // A violation with no service is named by its rule instead.
        {
          field: 'external_network',
          code: 'external_network',
          message: 'network legacy is declared external.',
        },
      ],
    });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'deployment.compose_policy.blocked',
        actorType: 'system',
        targetId: 'inst-1',
        outcome: 'failure',
        detail: {
          entryKey: 'D01-01',
          violations: [
            { rule: 'privileged', service: 'app' },
            { rule: 'external_network', service: null },
          ],
        },
      }),
    );
    expect(db.calls.some((call) => call.sql.includes(INSERT_RESOLUTION))).toBe(false);
  });

  it('downgrades a waived violation to unsafe_approved and records that verdict', async () => {
    const { db, catalogRepo, service } = setup({
      entry: [entryRow()],
      waived: [{ rule: 'privileged' }, { rule: 'not_a_rule' }],
    });
    mirrorTree(catalogRepo, {
      'docker-compose.yml': BLOCKED.replace('networks:\n  legacy:\n    external: true\n', ''),
    });

    const resolved = await service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' });

    expect(resolved.policy.verdict).toBe('unsafe_approved');
    expect(resolved.policy.waived).toEqual(['privileged']);
    expect(db.calls.find((call) => call.sql.includes(INSERT_RESOLUTION))?.params[6]).toBe(
      'unsafe_approved',
    );
  });

  it('refuses a compose file that does not parse, before a job can start', async () => {
    const { service, catalogRepo } = setup({ entry: [entryRow()] });
    // A top-level sequence is not a compose project: the refusal names the shape it needed.
    mirrorTree(catalogRepo, { 'docker-compose.yml': '- app\n- db\n' });

    await expect(service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' })).rejects.toThrow(
      'a compose file must be a mapping at the top level',
    );
  });

  it('refuses a compose file that declares no services', async () => {
    const { service, catalogRepo } = setup({ entry: [entryRow()] });
    mirrorTree(catalogRepo, { 'docker-compose.yml': 'version: "3.9"\n' });

    await expect(service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' })).rejects.toThrow(
      'a compose file must declare `services`',
    );
  });
});

describe('resolve — persistence', () => {
  it('fails when the resolution row is not created', async () => {
    const { service } = setup({
      entry: [entryRow()],
      draft: [{ id: 'draft-1', files: DRAFT_FILES }],
      resolution: [],
    });

    await expect(
      service.resolve({ instanceId: 'inst-1', entryKey: 'D01-01' }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The source resolution row was not created.',
      remediation: 'Retry the deployment; the job has not started.',
    });
  });
});

describe('evaluate', () => {
  it('allows a compose file that breaks no rule', () => {
    const { service } = setup();

    const policy = service.evaluate(COMPOSE, []);

    expect(policy).toMatchObject({ verdict: 'allowed', violations: [], waived: [] });
    expect(policy.services).toEqual(['app']);
  });

  it('blocks a compose file that publishes a privileged service', () => {
    const { service } = setup();

    const policy = service.evaluate(
      'services:\n  app:\n    image: x:1\n    privileged: true\n',
      [],
    );

    expect(policy.verdict).toBe('blocked');
    expect(policy.violations).toEqual([
      expect.objectContaining({ rule: 'privileged', service: 'app' }),
    ]);
  });

  it('marks a violation covered by an approved exception as unsafe_approved', () => {
    const { service } = setup();

    const policy = service.evaluate('services:\n  app:\n    image: x:1\n    network_mode: host\n', [
      'network_mode_host',
    ]);

    expect(policy.verdict).toBe('unsafe_approved');
    expect(policy.waived).toEqual(['network_mode_host']);
  });
});

describe('scaffold', () => {
  it('serves the latest draft with no invented diagnostics', async () => {
    const { service } = setup({
      latest: [
        {
          id: 'draft-7',
          files: DRAFT_FILES,
          approved_by: null,
          created_at: new Date('2026-02-02T00:00:00.000Z'),
        },
      ],
    });

    const draft = await service.scaffold('D01-01');

    expect(draft).toMatchObject({
      entryKey: 'D01-01',
      draftId: 'draft-7',
      createdAt: '2026-02-02T00:00:00.000Z',
      approvedBy: null,
      diagnostics: [],
    });
    expect(draft.files).toEqual(DRAFT_FILES);
    // `created_at` is a Date on the row; nothing of the row leaks into the served draft.
    expect(Object.keys(draft).sort()).toEqual([
      'approvedBy',
      'createdAt',
      'diagnostics',
      'draftId',
      'entryKey',
      'files',
    ]);
  });

  it('refuses an entry that has no draft', async () => {
    const { service } = setup();

    await expect(service.scaffold('D01-01')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'D01-01 has no scaffold draft.',
      remediation: 'This product ships a Compose file or a Dockerfile, so no scaffold is needed.',
    });
  });
});

describe('confirmScaffold', () => {
  const ARTEFACT = {
    id: 'draft-1',
    files: DRAFT_FILES,
    created_at: new Date('2026-02-02T00:00:00.000Z'),
    approved_by: null,
  };

  it('writes the approved draft into the working tree and records the commit', async () => {
    const { audit, catalog, catalogRepo, db, service } = setup({ confirm: [ARTEFACT] });

    const confirmation = await service.confirmScaffold('D01-01', 'draft-1', 'actor-1');

    expect(confirmation.approvedBy).toBe('actor-1');
    expect(confirmation.files).toEqual(DRAFT_FILES);
    // Created-at is the confirmation instant, not the draft's.
    expect(confirmation.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    for (const file of DRAFT_FILES) {
      expect(readFileSync(join(catalogRepo, 'scaffold', 'D01-01', file.path), 'utf8')).toBe(
        file.content,
      );
    }

    const sha = String(audit.append.mock.calls[0]?.[0]?.detail?.sha);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'catalog.scaffold.confirmed',
        actorId: 'actor-1',
        targetId: 'D01-01',
        detail: {
          draftId: 'draft-1',
          files: ['Dockerfile', 'app/compose.yaml'],
          sha,
        },
      }),
    );
    expect(catalog.recordCommit).toHaveBeenCalledWith({
      sha,
      kind: 'scaffold',
      actor: 'actor-1',
      message: 'Confirm scaffold draft for D01-01',
    });
    expect(db.calls.find((call) => call.sql.includes(UPDATE_SCAFFOLD))?.params).toEqual([
      'draft-1',
      'actor-1',
    ]);
    expect(db.calls.some((call) => call.sql.includes(TOUCH_ENTRY))).toBe(true);
  });

  it('refuses a draft that does not exist', async () => {
    const { catalog, service } = setup();

    await expect(service.confirmScaffold('D01-01', 'draft-9', 'actor-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No scaffold draft draft-9 for D01-01.',
      remediation: 'Reload the catalog entry and regenerate the draft.',
    });
    expect(catalog.recordCommit).not.toHaveBeenCalled();
  });

  it('refuses a stored artefact whose files do not satisfy the draft contract', async () => {
    const { service } = setup({
      confirm: [{ ...ARTEFACT, files: [{ path: 'Dockerfile' }] }],
    });

    await expect(service.confirmScaffold('D01-01', 'draft-1', 'actor-1')).rejects.toThrow();
  });

  it('refuses a draft file that would be written outside the entry directory', async () => {
    const { service } = setup({
      confirm: [
        {
          ...ARTEFACT,
          files: [{ path: '../escape.txt', language: 'text', content: 'x' }],
        },
      ],
    });

    await expect(service.confirmScaffold('D01-01', 'draft-1', 'actor-1')).rejects.toThrow(
      /path escapes its root/,
    );
  });
});
