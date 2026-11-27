import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fakeDb, type Route } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { DeploymentPipeline } from '../../../../src/modules/m05-executor/pipeline';
import { PipelineRegistry, type PipelineContext } from '../../../../src/jobs/pipeline-registry';
import type { RenderSet } from '../../../../src/modules/m03-renderer/renderer.contract';

/**
 * The deployment pipeline, driven stage by stage against injected fakes.
 *
 * Nothing here runs the whole pipeline: each stage is asked to prove one thing about the sequence it
 * is part of — that `plan` refuses a definition that drifted, that `apply` checks cancellation
 * before it touches Docker, that `verify` fails on evidence instead of waiting out the clock, and
 * that `record` is the only stage that declares an instance ready. The stage order and the failure
 * handlers are asserted once, from the registry, because that is where they live.
 */
const DATA_DIR = resolve(process.cwd(), '../../temp/m05-pipeline');
const INSTANCE_ID = '4a1e6f7c-0000-4000-8000-000000000001';
const COMPOSE = 'docker-compose.platform.yml';
/** The digest the catalogue records and the daemon reports, by default the same one. */
const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;

const INSTANCE_ROW = {
  id: INSTANCE_ID,
  entry_key: 'D01-01',
  slug: 'crm',
  domain_route: 'crm.seamnex.local',
  profile_key: null as string | null,
  state: 'deploying',
  payload: {} as Record<string, unknown>,
  source_path: 'compose' as const,
  route_host: null as string | null,
};

const DEFAULTS: readonly Route[] = [
  ['SELECT i.id, i.entry_key, i.slug, i.domain_route', [INSTANCE_ROW]],
  ['SELECT slug, state FROM instance', [{ slug: 'crm', state: 'verifying' }]],
  ['SELECT content_hash FROM instance_param', [{ content_hash: 'h' }]],
  ['instanceParamDrift', [{ drifted: false }]],
  ['SELECT id FROM render_set', []],
  ['FROM instance_env_value', []],
  ['SELECT payload FROM catalog_entry', []],
];

function policy(overrides: Record<string, unknown> = {}) {
  return {
    verdict: 'allowed',
    violations: [],
    waived: [],
    document: {},
    patch: [],
    publishedPorts: 0,
    services: [],
    ...overrides,
  };
}

function sourceOf(overrides: Record<string, unknown> = {}) {
  return {
    resolutionId: 'res-1',
    path: 'compose',
    sourceUrl: 'https://example.test/crm.git',
    revision: 'main',
    directory: '/work/crm',
    composeFile: 'docker-compose.yml',
    dockerfilePath: null,
    imageRef: 'repo/crm:7.4',
    imageDigest: IMAGE_DIGEST,
    policy: policy(),
    files: [{ path: 'docker-compose.yml', sha256: 'a'.repeat(64), content: 'services: {}' }],
    ...overrides,
  };
}

function renderSetOf(overrides: Record<string, unknown> = {}): RenderSet {
  return {
    id: 'rs-000000000001',
    instanceId: INSTANCE_ID,
    contentHash: 'hash-1',
    directory: '/work/crm/render',
    files: [
      {
        path: COMPOSE,
        sha256: 'b'.repeat(64),
        content: 'services:\n  app:\n    expose:\n      - "80"\n',
      },
    ],
    composeProject: 'seamnex-crm',
    imageRefs: ['repo/crm:7.4'],
    publishedPorts: 0,
    ...overrides,
  } as RenderSet;
}

/** A definition that builds its own primary image: the shape `D07-01` uses. */
function localRenderSet(): RenderSet {
  return renderSetOf({
    files: [
      {
        path: COMPOSE,
        sha256: 'd'.repeat(64),
        content: 'services:\n  app:\n    image: seamnex/crm:1\n    build: .\n',
      },
    ],
  });
}

function planRecord(overrides: Record<string, unknown> = {}) {
  return {
    planId: 'plan-000000000001',
    instanceId: INSTANCE_ID,
    action: 'deploy',
    renderSetId: 'rs-000000000001',
    changes: [{ field: 'file:docker-compose.yml', from: 'absent', to: 'b'.repeat(12) }],
    capacityVerdict: 'admitted',
    policyVerdict: 'allowed',
    preUpgradeBackup: false,
    rollbackAvailable: false,
    ...overrides,
  };
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    admissible: true,
    headline: 'fits on this host',
    detail: '12 vCPU free',
    shortfall: { cpuMilli: 0, memoryMb: 0, diskMb: 0 },
    limits: { cpuMilli: 8_000, memoryMb: 16_384, diskMb: 200_000 },
    used: { cpuMilli: 2_000, memoryMb: 4_096, diskMb: 20_000 },
    source: 'measured',
    ...overrides,
  };
}

type LineSink = (line: string) => Promise<void>;

/**
 * What `runChecks` answers. `check` stays a plain string here on purpose: the fake names the checks
 * the test asserts on, and pinning it to the integration union would only hide a renamed check.
 */
type CheckVerdict = {
  checks: { check: string; ok: boolean; detail: string }[];
  ready: boolean;
  blocking: string[];
  installPending: string | null;
};

function container(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    name: '/crm-app-1',
    service: 'app',
    image: 'repo/crm:7.4',
    state: 'running',
    status: 'Up',
    labels: {},
    ...overrides,
  };
}

/** The summary the scan service returns; the pipeline only reads `verdict`. */
function scanSummary(scanner: string, verdict: 'passed' | 'blocked' | 'error'): unknown {
  return {
    verdict,
    scanner,
    scannerVersion: '0.57.1',
    scannedAt: '2026-11-19T15:43:39.000Z',
    severityCounts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    blockingSeverities: ['critical'],
  };
}

function setup(routes: readonly Route[] = [], configOverrides: Record<string, unknown> = {}) {
  const db = fakeDb([...routes, ...DEFAULTS], { allowUnmatched: true });
  const registry = new PipelineRegistry();
  const sources = {
    resolve: vi.fn(async (input: { onProgress?: (line: string) => Promise<void> }) => {
      await input.onProgress?.('cloning example');
      return sourceOf();
    }),
  };
  const renderer = {
    render: vi.fn(async () => renderSetOf()),
    load: vi.fn(async () => renderSetOf()),
    // `applied` answers `null` for an instance that was never rendered; the fakes must say so.
    applied: vi.fn(async (_instanceId: string): Promise<RenderSet | null> => renderSetOf()),
  };
  const planner = { plan: vi.fn(async () => planRecord()) };
  const capacity = {
    admit: vi.fn(async () => decision()),
    reserve: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
  const secrets = { open: vi.fn(async (ref: string) => `value-of-${ref}`) };
  const audit = { append: vi.fn(async () => ({ seq: '1', hash: 'h' })) };
  const jobs = { get: vi.fn(async () => ({ id: 'job-backup', state: 'succeeded' })) };
  const docker = {
    build: vi.fn(async () => undefined),
    buildMirrors: vi.fn((): string[] => []),
    ensureNetwork: vi.fn(async () => undefined),
    composeBuild: vi.fn(async (_project: unknown, onLine?: LineSink) => {
      await onLine?.('build output');
    }),
    composeUp: vi.fn(async (_project: unknown, onLine?: LineSink) => {
      await onLine?.('up to date');
    }),
    composeDown: vi.fn(async () => undefined),
    removeNetwork: vi.fn(async () => undefined),
    containers: vi.fn(async (_labels: readonly string[], _all = true) => [container()]),
    inspect: vi.fn(async (_id: string) => ({
      State: { Status: 'running', ExitCode: 0 },
      RestartCount: 0,
    })),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    pull: vi.fn(async (_ref: string, onProgress?: LineSink) => {
      await onProgress?.('Pulling from library/crm');
      return { ref: 'repo/crm:7.4', digest: 'sha256:abc', id: 'sha256:abc' };
    }),
    logs: vi.fn(async () => ''),
    imageIdentity: vi.fn(async () => ({ ref: 'repo/crm:7.4', digest: IMAGE_DIGEST, id: 'abc' })),
    imageExists: vi.fn(async (_ref: string) => true),
    imageId: vi.fn(async (_ref: string) => IMAGE_DIGEST as string | null),
    repoDigest: vi.fn(async (_ref: string) => IMAGE_DIGEST as string | null),
    networkEndpoints: vi.fn(async () => [] as unknown[]),
    disconnectNetwork: vi.fn(async () => undefined),
    volumes: vi.fn(async (_labels: readonly string[]) => [] as unknown[]),
    volumeExists: vi.fn(async (_name: string) => true),
    volumeUsageMb: vi.fn(async (_name: string) => 0),
    runCli: vi.fn(async () => ({ code: 0, stdout: 'HTTP 200 OK', stderr: '', truncated: false })),
  };
  const integration = {
    materialiseRoute: vi.fn(async () => ({
      host: 'crm.seamnex.local',
      pathPrefix: '/',
      publishModel: 'subdomain',
      authMode: 'native',
      gated: false,
      published: true,
    })),
    // An entry that declares no identity-secret variable: the render stage asks, and the answer is
    // that there is nothing to apply. A test that provisions one replaces this answer.
    ensureIdentitySecret: vi.fn(async (): Promise<{ variable: string | null; status: string }> => ({
      variable: null,
      status: 'not-declared',
    })),
    registerIdentity: vi.fn(async () => ({
      clientId: 'seamnex-crm',
      adapter: { adapter: 'oidc', syncState: 'applied' },
    })),
    runChecks: vi.fn(async (_instanceId: string): Promise<CheckVerdict> => ({
      checks: [],
      ready: true,
      blocking: [],
      installPending: null,
    })),
  };
  const outbox = { emit: vi.fn(async () => undefined) };
  // Scanning is off in these cases (`SEAMNEX_SCAN_ENABLED` is unset), so the default answer reports
  // "nothing scanned" rather than a pass; a test that needs findings replaces the answer. The
  // callback is exercised by default because that is the seam the job log is written through.
  const images = {
    scanForDeploy: vi.fn(
      async (input: {
        readonly log?: (level: 'stdout' | 'system', line: string) => Promise<void>;
      }): Promise<string[]> => {
        await input.log?.('stdout', 'scanning the images this deployment will start');
        return [];
      },
    ),
  };
  const config = {
    SEAMNEX_ADAPTERS_MODE: 'real',
    SEAMNEX_DOCKER_HOST: 'unix:///var/run/docker.sock',
    SEAMNEX_VERIFY_TIMEOUT_MS: 30_000,
    SEAMNEX_VERIFY_MAX_RESTARTS: 3,
    SEAMNEX_VERIFY_UNHEALTHY_GRACE_MS: 0,
    SEAMNEX_INSTANCE_DATA_DIR: DATA_DIR,
    // No vendored tree by default: `prepull` then falls back to the pull, which is what the registry
    // entries in these cases are. A test that builds passes its own mirror directory.
    SEAMNEX_SOURCE_MIRROR_DIR: '',
    SEAMNEX_CATALOG_REPO_PATH: resolve(DATA_DIR, 'catalog'),
    // One path serves both sides on this host, which is the normal deployment.
    SEAMNEX_DOCKER_PATH_MAP: '',
    // The certificate the deployment's edge serves, used when a legacy payload names none (ISSUE-07).
    SEAMNEX_EDGE_TLS_MODE: 'acme',
    ...configOverrides,
  } as unknown as AppConfig;

  const pipeline = new DeploymentPipeline(
    db.pool,
    config,
    sources as never,
    renderer as never,
    planner as never,
    capacity as never,
    secrets as never,
    audit as never,
    jobs as never,
    docker as never,
    integration as never,
    registry,
    outbox as never,
    images as never,
  );
  pipeline.onModuleInit();

  /** Runs one registered stage by name: the only way into the pipeline's private methods. */
  const run = async (kind: string, name: string, context: PipelineContext): Promise<void> => {
    const stage = registry.stages(kind)?.find((candidate) => candidate.name === name);
    if (stage === undefined) throw new Error(`no stage ${kind}/${name}`);
    await stage.run(context);
  };

  return {
    db,
    registry,
    sources,
    renderer,
    planner,
    capacity,
    secrets,
    audit,
    jobs,
    docker,
    integration,
    outbox,
    images,
    config,
    pipeline,
    run,
  };
}

function ctx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    jobId: 'job-1',
    instanceId: INSTANCE_ID,
    actorId: 'alice',
    action: 'deploy',
    payload: {},
    log: vi.fn(async () => undefined),
    cancelled: vi.fn(async () => false),
    ...overrides,
  };
}

/**
 * Advances the fake clock until `promise` settles, so a stage that polls on a 3 s timer can be
 * driven through every branch it has without a real sleep.
 */
async function settle<T>(promise: Promise<T>, stepMs = 3_000, maxSteps = 60): Promise<T> {
  let done = false;
  const tracked = promise.then(
    (value) => {
      done = true;
      return value;
    },
    (error: unknown) => {
      done = true;
      throw error;
    },
  );
  tracked.catch(() => undefined);
  for (let index = 0; index < maxSteps && !done; index += 1) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (!done) throw new Error('the stage never settled inside the advanced window');
  return tracked;
}

beforeAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registration', () => {
  it('registers a stage list per kind, in the order the plan describes', () => {
    const { registry } = setup();

    expect(registry.stages('deploy')?.map((stage) => stage.name)).toEqual([
      'resolve',
      'render',
      'plan',
      'build',
      'apply',
      'verify',
      'integrate',
      'record',
    ]);
    // A reconfigure is a deploy: same stages, so there is one definition of "apply this".
    expect(registry.stepsFor('reconfigure')).toEqual(registry.stepsFor('deploy'));
    expect(registry.stages('upgrade')?.map((stage) => stage.name)).toContain('backup');
    // The build sits after admission (a refused entry costs no build) and before apply.
    expect(registry.stepsFor('deploy').indexOf('Build images')).toBeLessThan(
      registry.stepsFor('deploy').indexOf('Apply'),
    );
    expect(registry.stepsFor('upgrade')).toHaveLength(9);
    expect(registry.stages('rollback')?.map((stage) => stage.name)).toEqual([
      'resolve',
      'plan',
      'apply',
      'verify',
      'record',
    ]);
    expect(registry.stepsFor('start')).toEqual(['start containers', 'Record state']);
    expect(registry.stepsFor('delete')).toEqual(['Remove project', 'Record deletion']);
    expect(registry.stepsFor('export')).toEqual(['Archive data and render set', 'Record export']);
    expect(registry.stepsFor('prepull')).toEqual(['Resolve images']);
    expect(registry.stepsFor('build')).toEqual(['Build image', 'Record artefact']);
    expect(registry.stepsFor('verify')).toEqual([]);
  });

  it('registers a failure handler for every kind that owns an instance state, and for no other', () => {
    const { registry } = setup();

    for (const kind of [
      'deploy',
      'reconfigure',
      'upgrade',
      'rollback',
      'delete',
      'export',
      'start',
      'stop',
      'restart',
    ]) {
      expect(registry.failureHandler(kind)).toBeTypeOf('function');
    }
    // Neither kind owns the instance lifecycle, so neither may move it to `failed`.
    expect(registry.failureHandler('build')).toBeUndefined();
    expect(registry.failureHandler('prepull')).toBeUndefined();
  });
});

describe('resolve', () => {
  it('resolves the source, records the run and streams the resolver progress', async () => {
    const { db, sources, run } = setup();
    const context = ctx({ payload: { revision: 'r2' } });

    await run('deploy', 'resolve', context);

    expect(sources.resolve).toHaveBeenCalledWith({
      instanceId: INSTANCE_ID,
      entryKey: 'D01-01',
      revision: 'r2',
      onProgress: expect.any(Function),
    });
    expect(context.log).toHaveBeenCalledWith('stdout', 'cloning example');
    expect(context.log).toHaveBeenCalledWith('stdout', 'source retained: docker-compose.yml');
    // The instance moves into the first transitional state of the machine.
    expect(db.calls.some((call) => call.params[1] === 'resolving')).toBe(true);
  });

  it('omits the revision it was not given, and reports an empty file list as none', async () => {
    const { sources, run } = setup();
    sources.resolve.mockResolvedValue(sourceOf({ files: [] }) as never);
    const context = ctx();

    await run('deploy', 'resolve', context);

    expect(sources.resolve.mock.calls[0]?.[0]).not.toHaveProperty('revision');
    expect(context.log).toHaveBeenCalledWith('stdout', 'source retained: none');
  });

  it('answers 404 for a job whose instance no longer exists', async () => {
    const { run } = setup([['SELECT i.id, i.entry_key, i.slug, i.domain_route', []]]);

    await expect(run('deploy', 'resolve', ctx())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No instance ${INSTANCE_ID}.`,
    });
  });
});

describe('resolveRollback', () => {
  it('loads the render set named by the job', async () => {
    const { renderer, run } = setup();
    renderer.load.mockResolvedValue(renderSetOf({ id: 'rs-previous-1234' }));
    const context = ctx({ action: 'rollback', payload: { renderSetId: 'rs-previous-1234' } });

    await run('rollback', 'resolve', context);

    expect(renderer.load).toHaveBeenCalledWith('rs-previous-1234');
    expect(context.log).toHaveBeenCalledWith('stdout', 'rollback target render set rs-previous-');
  });

  it('falls back to the previous applied render set', async () => {
    const { db, renderer, run } = setup([['SELECT id FROM render_set', [{ id: 'rs-offset-1' }]]]);

    await run('rollback', 'resolve', ctx({ action: 'rollback' }));

    expect(renderer.load).toHaveBeenCalledWith('rs-offset-1');
    expect(db.calls.some((call) => call.sql.includes('OFFSET 1'))).toBe(true);
  });

  it('refuses a rollback with no predecessor to roll back to', async () => {
    const { run } = setup([['SELECT id FROM render_set', []]]);

    await expect(run('rollback', 'resolve', ctx({ action: 'rollback' }))).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'There is no previous render set to roll back to.',
    });
  });
});

describe('render', () => {
  it('renders from the resolved source, defaulting the profile and reading the payload route', async () => {
    const { renderer, run } = setup([
      [
        'SELECT i.id, i.entry_key, i.slug, i.domain_route',
        [
          {
            ...INSTANCE_ROW,
            payload: {
              httpPort: 8080,
              route: { host: 'payload.seamnex.local', pathPrefix: '/sub', authMode: 'fa_header' },
              resources: { cpu: 2, memoryMb: 2_048, diskMb: 4_096 },
            },
          },
        ],
      ],
    ]);
    const context = ctx();

    await run('deploy', 'resolve', context);
    await run('deploy', 'render', context);

    expect(renderer.render).toHaveBeenCalledWith({
      instanceId: INSTANCE_ID,
      entryKey: 'D01-01',
      slug: 'crm',
      action: 'deploy',
      profileKey: 'default',
      source: {
        path: 'compose',
        directory: '/work/crm',
        composeFile: 'docker-compose.yml',
        dockerfilePath: null,
        imageRef: 'repo/crm:7.4',
        policy: policy(),
      },
      route: {
        host: 'payload.seamnex.local',
        pathPrefix: '/sub',
        publishModel: 'subdomain',
        tlsMode: 'acme',
        authMode: 'fa_header',
      },
      resources: { cpuMilli: 2_000, memoryMb: 2_048, diskMb: 4_096 },
      httpPort: 8080,
    });
    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      'render set rs-000000000 (1 files, 0 published, 0 rewritten to expose)',
    );
  });

  it('applies the identity client secret before the definition that carries it', async () => {
    /*
     * The ordering is the defect: `registerIdentity` runs after `apply` because it needs the route,
     * so a secret minted there reached no container on the deployment that needed it. ERPNext booted
     * without `ERPNEXT_SSO_CLIENT_SECRET`, wrote no `Social Login Key`, and the platform still called
     * it single sign-on.
     */
    const { integration, renderer, run } = setup([
      [
        'SELECT i.id, i.entry_key, i.slug, i.domain_route',
        [{ ...INSTANCE_ROW, entry_key: 'D06-01' }],
      ],
    ]);
    integration.ensureIdentitySecret.mockResolvedValueOnce({
      variable: 'ERPNEXT_SSO_CLIENT_SECRET',
      status: 'minted',
    });
    const context = ctx();

    await run('deploy', 'resolve', context);
    await run('deploy', 'render', context);

    expect(integration.ensureIdentitySecret).toHaveBeenCalledWith(INSTANCE_ID, 'alice');
    expect(integration.ensureIdentitySecret.mock.invocationCallOrder[0]).toBeLessThan(
      renderer.render.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      'ERPNEXT_SSO_CLIENT_SECRET generated and stored as the instance secret it is applied from',
    );
  });

  it('says nothing when the instance already carries the identity client secret', async () => {
    const { integration, run } = setup();
    integration.ensureIdentitySecret.mockResolvedValueOnce({
      variable: 'ERPNEXT_SSO_CLIENT_SECRET',
      status: 'applied',
    });
    const context = ctx();

    await run('deploy', 'resolve', context);
    await run('deploy', 'render', context);

    const lines = vi
      .mocked(context.log)
      .mock.calls.map((call) => String(call[1]))
      .filter((line) => line.includes('ERPNEXT_SSO_CLIENT_SECRET'));
    expect(lines).toEqual([]);
  });

  it('prefers the recorded profile and falls back to the domain route and default resources', async () => {
    const { renderer, run } = setup([
      [
        'SELECT i.id, i.entry_key, i.slug, i.domain_route',
        [{ ...INSTANCE_ROW, profile_key: 'prod' }],
      ],
    ]);
    const context = ctx();

    await run('deploy', 'resolve', context);
    await run('deploy', 'render', context);

    expect(renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({
        profileKey: 'prod',
        route: {
          host: 'crm.seamnex.local',
          pathPrefix: null,
          publishModel: 'subdomain',
          tlsMode: 'acme',
          authMode: 'native',
        },
        resources: { cpuMilli: 1_000, memoryMb: 1_024, diskMb: 2_048 },
        httpPort: 80,
      }),
    );
  });

  it('renders the host the route row publishes, not the deploy-time snapshot', async () => {
    // A domain change rewrites `instance_route` and leaves `instance.payload.route.host` at the
    // value the deploy wrote. Rendering from the snapshot put the retired host into `route.json`
    // for every product deployed before the change.
    const { renderer, run } = setup([
      [
        'SELECT i.id, i.entry_key, i.slug, i.domain_route',
        [
          {
            ...INSTANCE_ROW,
            route_host: 'crm.localhost',
            payload: { route: { host: 'crm.seamnex.local' } },
          },
        ],
      ],
    ]);
    const context = ctx();

    await run('deploy', 'resolve', context);
    await run('deploy', 'render', context);

    expect(renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ route: expect.objectContaining({ host: 'crm.localhost' }) }),
    );
  });

  it('refuses to render a job that never resolved', async () => {
    // A rollback resolves a render set, not a source: the run exists but has nothing to render from.
    const h = setup([['SELECT id FROM render_set', [{ id: 'rs-previous-1234' }]]]);
    const context = ctx({ action: 'rollback' });
    await h.run('rollback', 'resolve', context);

    await expect(h.run('deploy', 'render', context)).rejects.toThrow('render ran before resolve');
  });
});

describe('plan', () => {
  async function reachPlan(h: ReturnType<typeof setup>, context: PipelineContext): Promise<void> {
    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);
    await h.run('deploy', 'plan', context);
  }

  it('plans against the admission verdict, records it and moves to planned', async () => {
    const h = setup([
      [
        'SELECT i.id, i.entry_key, i.slug, i.domain_route',
        [{ ...INSTANCE_ROW, payload: { resources: { cpu: 2 } } }],
      ],
    ]);
    const context = ctx();

    await reachPlan(h, context);

    expect(h.capacity.admit).toHaveBeenCalledWith({
      instanceId: INSTANCE_ID,
      resources: { cpuMilli: 2_000, memoryMb: 1_024, diskMb: 2_048 },
    });
    expect(h.planner.plan).toHaveBeenCalledWith({
      instanceId: INSTANCE_ID,
      action: 'deploy',
      renderSetId: 'rs-000000000001',
      policyVerdict: 'allowed',
      capacity: {
        admissible: true,
        headline: 'fits on this host',
        detail: '12 vCPU free',
        source: 'measured',
      },
      preUpgradeBackup: false,
    });
    expect(h.db.calls.some((call) => call.params[1] === 'planned')).toBe(true);
    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      'plan plan-0000000: 1 change(s), capacity admitted, policy allowed',
    );
  });

  it('carries the blocked policy verdict and the pre-upgrade backup flag of an upgrade', async () => {
    const h = setup();
    h.sources.resolve.mockResolvedValue(
      sourceOf({ policy: policy({ verdict: 'unsafe_approved' }) }) as never,
    );
    const context = ctx({ action: 'upgrade', payload: { backupJobId: 'job-backup' } });

    await reachPlan(h, context);

    expect(h.planner.plan).toHaveBeenCalledWith(
      expect.objectContaining({ policyVerdict: 'unsafe_approved', preUpgradeBackup: true }),
    );
  });

  it('defaults the policy verdict when the run has no resolved source (a rollback)', async () => {
    const h = setup([['SELECT id FROM render_set', [{ id: 'rs-previous-1234' }]]]);
    h.renderer.load.mockResolvedValue(renderSetOf({ id: 'rs-previous-1234' }));
    const context = ctx({ action: 'rollback' });

    await h.run('rollback', 'resolve', context);
    await h.run('rollback', 'plan', context);

    expect(h.planner.plan).toHaveBeenCalledWith(
      expect.objectContaining({ policyVerdict: 'allowed' }),
    );
  });

  it('refuses to plan a job that never rendered', async () => {
    // `resolve` records the run before a render set exists, which is the state `plan` must refuse.
    const h = setup();
    const context = ctx();
    await h.run('deploy', 'resolve', context);

    await expect(h.run('deploy', 'plan', context)).rejects.toThrow('plan ran before render');
  });

  it('refuses a render set that still publishes a port, as a normalisation defect', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(renderSetOf({ publishedPorts: 1 }));
    const context = ctx();

    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);

    await expect(h.run('deploy', 'plan', context)).rejects.toMatchObject({
      code: 'COMPOSE_POLICY_BLOCKED',
      detail: 'The render set still declares 1 published port(s).',
    });
    expect(h.planner.plan).not.toHaveBeenCalled();
  });

  it('refuses a definition that no longer matches its recorded hash', async () => {
    const h = setup([['instanceParamDrift', [{ drifted: true }]]]);
    const context = ctx();

    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);

    await expect(h.run('deploy', 'plan', context)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'instances/crm/instance.yaml does not match its recorded hash.',
    });
  });

  it('waits for a definition that is committed a moment later', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const h = setup([
      [
        'SELECT content_hash FROM instance_param',
        () => (++reads === 1 ? [] : [{ content_hash: 'h' }]),
      ],
    ]);
    const context = ctx();
    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);

    await settle(h.run('deploy', 'plan', context), 500);

    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      'waiting for instances/<slug>/instance.yaml to be committed',
    );
    expect(h.planner.plan).toHaveBeenCalledOnce();
  });

  it('gives up after ten polls when the definition was never committed', async () => {
    vi.useFakeTimers();
    const h = setup([['SELECT content_hash FROM instance_param', []]]);
    const context = ctx();
    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);

    await expect(settle(h.run('deploy', 'plan', context), 500)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'The instance definition was never committed to the catalogue repository.',
    });
    expect(h.db.calls.filter((call) => call.sql.includes('FROM instance_param'))).toHaveLength(10);
  });

  it('refuses when the host has no capacity, quoting the headline', async () => {
    const h = setup();
    h.capacity.admit.mockResolvedValue(
      decision({ admissible: false, headline: 'no room', detail: 'need 2 vCPU' }),
    );
    h.planner.plan.mockResolvedValue(planRecord({ capacityVerdict: 'refused' }));
    const context = ctx();
    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);

    await expect(h.run('deploy', 'plan', context)).rejects.toMatchObject({
      code: 'CAPACITY_EXCEEDED',
      detail: 'no room',
    });
  });

  it('refuses when capacity cannot be measured at all', async () => {
    const h = setup();
    h.planner.plan.mockResolvedValue(planRecord({ capacityVerdict: 'unknown' }));
    const context = ctx();
    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);

    await expect(h.run('deploy', 'plan', context)).rejects.toMatchObject({
      code: 'CAPACITY_EXCEEDED',
      detail: 'Capacity could not be measured, so the deployment was not admitted.',
    });
  });
});

describe('requireBackup', () => {
  it('accepts an upgrade whose pre-upgrade backup succeeded', async () => {
    const { jobs, run } = setup();
    const context = ctx({ action: 'upgrade', payload: { backupJobId: 'job-backup' } });

    await run('upgrade', 'backup', context);

    expect(jobs.get).toHaveBeenCalledWith('job-backup');
    expect(context.log).toHaveBeenCalledWith('stdout', 'pre-upgrade backup job-backup verified');
  });

  it('refuses an upgrade with no backup attached', async () => {
    const { run } = setup();

    await expect(run('upgrade', 'backup', ctx({ action: 'upgrade' }))).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'An upgrade must be preceded by a backup job, and none was attached.',
    });
  });

  it('refuses an upgrade whose backup has not succeeded', async () => {
    const { jobs, run } = setup();
    jobs.get.mockResolvedValue({ id: 'job-backup', state: 'failed' } as never);

    await expect(
      run('upgrade', 'backup', ctx({ action: 'upgrade', payload: { backupJobId: 'job-backup' } })),
    ).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'The pre-upgrade backup job job-backup is failed, not succeeded.',
    });
  });
});

describe('deploy build stage', () => {
  async function reachBuild(h: ReturnType<typeof setup>, context: PipelineContext): Promise<void> {
    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);
  }

  it('builds a Dockerfile source and remembers the id it produced', async () => {
    const h = setup();
    h.sources.resolve.mockResolvedValue(
      sourceOf({
        path: 'dockerfile',
        dockerfilePath: '/work/crm/Dockerfile',
        imageRef: 'repo/crm:dev',
      }) as never,
    );
    const context = ctx();
    await reachBuild(h, context);

    await h.run('deploy', 'build', context);

    expect(context.log).toHaveBeenCalledWith('stdout', 'building repo/crm:dev from /work/crm');
    expect(h.docker.build).toHaveBeenCalledWith({
      context: '/work/crm',
      dockerfile: '/work/crm/Dockerfile',
      tag: 'repo/crm:dev',
      labels: { 'seamnex.instance': INSTANCE_ID, 'seamnex.entry': 'D01-01' },
    });
    // The id is the artefact: `apply` proves the tag against it, and `record` writes it for the review.
    expect(context.log).toHaveBeenCalledWith('stdout', `repo/crm:dev built as ${IMAGE_DIGEST}`);
  });

  it('falls back to the conventional Dockerfile name for a scaffold', async () => {
    const h = setup();
    h.sources.resolve.mockResolvedValue(
      sourceOf({
        path: 'scaffold',
        directory: '/work/scaffold',
        dockerfilePath: null,
        imageRef: 'repo/s:1',
      }) as never,
    );
    const context = ctx();
    await reachBuild(h, context);

    await h.run('deploy', 'build', context);

    expect(h.docker.build).toHaveBeenCalledWith(
      expect.objectContaining({ dockerfile: join('/work/scaffold', 'Dockerfile') }),
    );
  });

  it('builds what the definition declares, through Compose, and captures the tag it produced', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(
      renderSetOf({
        files: [
          {
            path: COMPOSE,
            sha256: 'c'.repeat(64),
            content:
              'services:\n  app:\n    image: seamnex/crm:1\n    build: .\n  db:\n    image: mariadb:11\n',
          },
        ],
      }),
    );
    const context = ctx();
    await reachBuild(h, context);

    await h.run('deploy', 'build', context);

    expect(context.log).toHaveBeenCalledWith('stdout', 'building from the definition: app');
    expect(h.docker.composeBuild).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'seamnex-crm' }),
      expect.any(Function),
    );
    expect(context.log).toHaveBeenCalledWith('stdout', 'build output');
    expect(context.log).toHaveBeenCalledWith('stdout', `seamnex/crm:1 built as ${IMAGE_DIGEST}`);
    // One build per artefact: the Compose path is the build, not a second `buildx` on top of it.
    expect(h.docker.build).not.toHaveBeenCalled();
    // Nothing is claimed about mirrors when none is configured, so the log stays honest.
    expect(context.log).not.toHaveBeenCalledWith(
      'stdout',
      expect.stringContaining('package mirrors forwarded'),
    );
  });

  /**
   * The mirror a host configured has to be visible in the job log.
   *
   * The original defect was silent: `APT_MIRROR` was set in `.env`, no build read it, and the stage
   * showed only "building from the definition" while it crawled a CDN the host could not reach. A log
   * line naming what was forwarded is what makes the next occurrence diagnosable from the screen.
   */
  it('names the package mirrors it forwards to the build', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(localRenderSet());
    h.docker.buildMirrors.mockReturnValue(['APT_MIRROR', 'NPM_REGISTRY']);
    const context = ctx();
    await reachBuild(h, context);

    await h.run('deploy', 'build', context);

    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      'package mirrors forwarded to the build: APT_MIRROR, NPM_REGISTRY (host settings, never written into the image)',
    );
    expect(h.docker.composeBuild).toHaveBeenCalled();
  });

  it('does nothing when the source declares no image reference', async () => {
    const h = setup();
    h.sources.resolve.mockResolvedValue(
      sourceOf({
        path: 'dockerfile',
        dockerfilePath: '/work/crm/Dockerfile',
        imageRef: null,
      }) as never,
    );
    const context = ctx();
    await reachBuild(h, context);

    await h.run('deploy', 'build', context);

    expect(h.docker.build).not.toHaveBeenCalled();
  });

  it('fails before apply when the build leaves no image under the tag', async () => {
    const h = setup();
    h.sources.resolve.mockResolvedValue(
      sourceOf({
        path: 'dockerfile',
        dockerfilePath: '/work/crm/Dockerfile',
        imageRef: 'repo/crm:dev',
      }) as never,
    );
    h.docker.imageId.mockResolvedValue(null);
    const context = ctx();
    await reachBuild(h, context);

    await expect(h.run('deploy', 'build', context)).rejects.toMatchObject({
      code: 'IMAGE_DIGEST_MISMATCH',
      detail: expect.stringContaining('holds no image under that tag'),
    });
  });
});

describe('apply', () => {
  async function reachApply(h: ReturnType<typeof setup>, context: PipelineContext): Promise<void> {
    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);
  }

  it('applies the compose project and streams the daemon output', async () => {
    const h = setup();
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(h.docker.ensureNetwork).toHaveBeenCalledWith('seamnex-inst-crm', {
      'seamnex.instance': INSTANCE_ID,
    });
    expect(h.docker.composeUp).toHaveBeenCalledWith(
      {
        project: 'seamnex-crm',
        directory: '/work/crm/render',
        files: [
          join('/work/crm/render', 'docker-compose.platform.yml'),
          join('/work/crm/render', 'docker-compose.override.yml'),
        ],
        envFiles: [join('/work/crm/render', 'platform.env')],
      },
      expect.any(Function),
    );
    // The daemon's own output reaches the job log, one line at a time.
    expect(context.log).toHaveBeenCalledWith('stdout', 'up to date');
    expect(context.log).toHaveBeenCalledWith('stdout', 'compose project applied');
  });

  it('does nothing at all when the job was cancelled before apply', async () => {
    const h = setup();
    const context = ctx({ cancelled: vi.fn(async () => true) });
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(context.log).toHaveBeenCalledWith(
      'system',
      'cancelled before apply; nothing was changed',
    );
    expect(h.docker.composeUp).not.toHaveBeenCalled();
  });

  it('refuses to apply while the Docker adapter is switched off', async () => {
    const h = setup([], { SEAMNEX_ADAPTERS_MODE: 'disabled' });
    const context = ctx();
    await reachApply(h, context);

    await expect(h.run('deploy', 'apply', context)).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('cannot be used'),
    });
    expect(h.docker.composeUp).not.toHaveBeenCalled();
  });

  it('refuses to apply when the Docker host is not configured', async () => {
    const h = setup([], { SEAMNEX_DOCKER_HOST: '  ' });
    const context = ctx();
    await reachApply(h, context);

    await expect(h.run('deploy', 'apply', context)).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('SEAMNEX_DOCKER_HOST is empty'),
    });
  });

  it('refuses to apply a job that never rendered', async () => {
    const h = setup();
    const context = ctx();
    // `resolve` records the run; nothing has rendered into it yet.
    await h.run('deploy', 'resolve', context);
    h.sources.resolve.mockClear();

    await expect(h.run('deploy', 'apply', context)).rejects.toThrow('apply ran before render');
    expect(h.docker.composeUp).not.toHaveBeenCalled();
  });

  it('refuses to start a definition whose image is not the digest the catalogue pins', async () => {
    const h = setup();
    h.docker.repoDigest.mockResolvedValue(`sha256:${'b'.repeat(64)}`);
    const context = ctx();
    await reachApply(h, context);

    await expect(h.run('deploy', 'apply', context)).rejects.toMatchObject({
      code: 'IMAGE_DIGEST_MISMATCH',
      detail: expect.stringContaining('repo/crm:7.4'),
    });
    // The comparison is worthless if it happens after the containers exist.
    expect(h.docker.composeUp).not.toHaveBeenCalled();
  });

  it('pulls an absent image so the pin can be compared, then applies', async () => {
    const h = setup();
    h.docker.imageExists.mockResolvedValue(false);
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    // The pin travels into the pull, so a mirror serving other content is refused inside the attempt.
    expect(h.docker.pull).toHaveBeenCalledWith('repo/crm:7.4', expect.any(Function), {
      expectedDigest: IMAGE_DIGEST,
    });
    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      `repo/crm:7.4 matches the pinned digest ${IMAGE_DIGEST}`,
    );
    expect(h.docker.composeUp).toHaveBeenCalled();
  });

  it('refuses when the build stage produced nothing for a declared build', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(localRenderSet());
    const context = ctx();
    await reachApply(h, context);
    // No build stage ran: the state carries no id, so there is nothing the tag can be proved against.
    await expect(h.run('deploy', 'apply', context)).rejects.toMatchObject({
      code: 'IMAGE_DIGEST_MISMATCH',
      detail: expect.stringContaining('produced no image'),
    });
    expect(h.docker.composeUp).not.toHaveBeenCalled();
    // And it must not have gone looking for one in a registry.
    expect(h.docker.pull).not.toHaveBeenCalled();
  });

  it('applies a locally built image without ever pulling it, and records the first baseline', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(localRenderSet());
    const context = ctx();
    await reachApply(h, context);
    await h.run('deploy', 'build', context);

    await h.run('deploy', 'apply', context);

    expect(h.docker.composeBuild).toHaveBeenCalled();
    expect(h.docker.pull).not.toHaveBeenCalled();
    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      `seamnex/crm:1 is this instance's first local build; recording ${IMAGE_DIGEST} as the baseline`,
    );
    expect(h.docker.composeUp).toHaveBeenCalled();
  });

  it('checks a rollback against the image recorded for the instance, since no build ran', async () => {
    const h = setup([
      ['FROM instance_service', [{ service_name: 'app', image_digest: IMAGE_DIGEST }]],
    ]);
    h.renderer.render.mockResolvedValue(localRenderSet());
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      `seamnex/crm:1 matches the image recorded for this instance (${IMAGE_DIGEST})`,
    );
    expect(h.docker.pull).not.toHaveBeenCalled();
    expect(h.docker.composeUp).toHaveBeenCalled();
  });

  it('refuses to start when the tag no longer resolves to the image this run built', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(localRenderSet());
    const context = ctx();
    await reachApply(h, context);
    await h.run('deploy', 'build', context);
    h.docker.imageId.mockResolvedValue(`sha256:${'c'.repeat(64)}`);

    await expect(h.run('deploy', 'apply', context)).rejects.toMatchObject({
      code: 'IMAGE_DIGEST_MISMATCH',
      detail: expect.stringContaining('retagged or replaced'),
    });
    expect(h.docker.composeUp).not.toHaveBeenCalled();
  });

  it('fails after up when the tag changed under the containers that just started', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(localRenderSet());
    const context = ctx();
    await reachApply(h, context);
    await h.run('deploy', 'build', context);
    // The build already consumed its own read; the next two are the pre-up pin and the post-up proof.
    h.docker.imageId
      .mockResolvedValueOnce(IMAGE_DIGEST)
      .mockResolvedValueOnce(`sha256:${'d'.repeat(64)}`);

    await expect(h.run('deploy', 'apply', context)).rejects.toMatchObject({
      code: 'IMAGE_DIGEST_MISMATCH',
      detail: expect.stringContaining('after the containers started'),
    });
    // The containers are left running on purpose; the job still reports failure.
    expect(h.docker.composeUp).toHaveBeenCalled();
  });

  it('injects the declared secrets as a runtime override and quotes the values that need it', async () => {
    const h = setup([
      [
        'FROM instance_env_value',
        [
          { var_name: 'DB_PASSWORD', secret_ref: 'sec-1' },
          { var_name: 'PLAIN', secret_ref: 'sec-2' },
          { var_name: 'SKIPPED', secret_ref: null },
        ],
      ],
    ]);
    h.secrets.open.mockImplementation(async (ref: string) =>
      ref === 'sec-1' ? 'p@ss word#1' : 'plain-value',
    );
    const renderSet = renderSetOf({ id: 'rs-with-secrets' });
    h.renderer.render.mockResolvedValue(renderSet);
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      '1 service(s) receive the declared secrets at apply time',
    );
    const runtimeDir = join(DATA_DIR, INSTANCE_ID, 'runtime');
    const env = readFileSync(join(runtimeDir, 'rs-with-secrets.env'), 'utf8');
    // A value with a space, a `#` or a quote is quoted; a plain one is written verbatim.
    expect(env).toBe('DB_PASSWORD="p@ss word#1"\nPLAIN=plain-value\n');
    const override = readFileSync(join(runtimeDir, 'rs-with-secrets.secrets.yml'), 'utf8');
    expect(override).toContain('app:');
    expect(override).toContain('DB_PASSWORD: p@ss word#1');
    // The override is a separate file from the render set, so no secret enters a stored artefact.
    expect(renderSet.files.map((file) => file.path)).toEqual([COMPOSE]);
  });

  it('writes no secrets file when every reference is empty or absent', async () => {
    const h = setup([['FROM instance_env_value', [{ var_name: 'A', secret_ref: null }]]]);
    h.renderer.render.mockResolvedValue(renderSetOf({ id: 'rs-null-refs' }));
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(h.secrets.open).not.toHaveBeenCalled();
    expect(context.log).not.toHaveBeenCalledWith(
      'stdout',
      expect.stringContaining('receive the declared secrets'),
    );
  });

  it('names the services from the definition, falling back to a single app service', async () => {
    const h = setup([['FROM instance_env_value', [{ var_name: 'A', secret_ref: 'sec-1' }]]]);
    h.renderer.render.mockResolvedValue(
      renderSetOf({
        id: 'rs-no-platform-file',
        files: [{ path: 'other.yml', sha256: 'd'.repeat(64), content: 'x: 1' }],
      }),
    );
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    const override = readFileSync(
      join(DATA_DIR, INSTANCE_ID, 'runtime', 'rs-no-platform-file.secrets.yml'),
      'utf8',
    );
    expect(override).toContain('app:');
  });

  it('includes the secrets files in every later compose invocation once they exist', async () => {
    const h = setup([['FROM instance_env_value', [{ var_name: 'A', secret_ref: 'sec-1' }]]]);
    h.renderer.render.mockResolvedValue(renderSetOf({ id: 'rs-twice' }));
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    const composeCall = h.docker.composeUp.mock.calls[0]?.[0] as {
      files: string[];
      envFiles: string[];
    };
    expect(composeCall.files).toContain(
      join(DATA_DIR, INSTANCE_ID, 'runtime', 'rs-twice.secrets.yml'),
    );
    expect(composeCall.envFiles).toContain(join(DATA_DIR, INSTANCE_ID, 'runtime', 'rs-twice.env'));
  });
});

describe('recordVolumes', () => {
  async function reachApply(h: ReturnType<typeof setup>, context: PipelineContext): Promise<void> {
    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);
  }

  it('registers the daemon’s volumes with the declared quota and drops the ones it no longer has', async () => {
    const h = setup([
      [
        "SELECT payload -> 'volumes'",
        [{ volumes: [{ name: 'db', mountPath: '/var/lib/mysql', quotaMb: 8_192 }] }],
      ],
      ['SELECT name FROM instance_volume', [{ name: 'seamnex-crm_old' }]],
    ]);
    h.docker.volumes.mockResolvedValue([
      {
        name: 'seamnex-crm_db',
        mountpoint: '/var/lib/docker/volumes/seamnex-crm_db/_data',
        labels: { 'com.docker.compose.volume': 'db' },
      },
    ]);
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(h.docker.volumes).toHaveBeenCalledWith(['com.docker.compose.project=seamnex-crm']);
    const insert = h.db.calls.find((call) => call.sql.includes('INSERT INTO instance_volume'));
    expect(insert?.params).toEqual([
      INSTANCE_ID,
      'seamnex-crm_db',
      '/var/lib/mysql',
      '/var/lib/docker/volumes/seamnex-crm_db/_data',
      8_192,
    ]);
    const remove = h.db.calls.find((call) => call.sql.includes('DELETE FROM instance_volume'));
    expect(remove?.params).toEqual([INSTANCE_ID, ['seamnex-crm_old']]);
    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      '1 data volume(s) registered for backup and quota checks: seamnex-crm_db',
    );
  });

  it('reads the mount path from the render set and the reservation when the catalog is silent', async () => {
    const h = setup([["SELECT payload -> 'volumes'", [{ volumes: [] }]]]);
    h.docker.volumes.mockResolvedValue([
      {
        name: 'seamnex-crm_media',
        mountpoint: '',
        labels: { 'com.docker.compose.volume': 'media' },
      },
    ]);
    // The volume key is not declared by the entry, so both the mount path and the quota have to
    // come from something else: the applied document and the instance's own disk reservation.
    h.renderer.render.mockResolvedValue(
      renderSetOf({
        files: [
          {
            path: COMPOSE,
            sha256: 'b'.repeat(64),
            content: 'services:\n  app:\n    volumes:\n      - media:/data\nvolumes:\n  media:\n',
          },
        ],
      }),
    );
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    const insert = h.db.calls.find((call) => call.sql.includes('INSERT INTO instance_volume'));
    // `resourcesOf` reads the instance document; an empty one declares 2 048 MB.
    expect(insert?.params).toEqual([INSTANCE_ID, 'seamnex-crm_media', '/data', null, 2_048]);
    expect(context.log).toHaveBeenCalledWith(
      'system',
      'volume seamnex-crm_media is not declared by D01-01; its quota is the instance reservation of 2048 MB',
    );
  });

  it('leaves the recorded set untouched when the daemon cannot be asked', async () => {
    const h = setup();
    h.docker.volumes.mockRejectedValue(new Error('daemon down'));
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    // Deleting on a failed read would erase the only record of where the data lives.
    expect(
      h.db.calls.some(
        (call) =>
          call.sql.includes('INSERT INTO instance_volume') ||
          call.sql.includes('DELETE FROM instance_volume'),
      ),
    ).toBe(false);
    expect(context.log).toHaveBeenCalledWith(
      'system',
      expect.stringContaining('could not be listed (daemon down)'),
    );
  });
});

describe('verify', () => {
  async function reachVerify(h: ReturnType<typeof setup>, context: PipelineContext): Promise<void> {
    await h.run('deploy', 'resolve', context);
  }

  function inspected(overrides: Record<string, unknown>) {
    return { State: { Status: 'running', ExitCode: 0, ...overrides }, RestartCount: 0 };
  }

  it('declares the instance ready as soon as the probe answers', async () => {
    const h = setup();
    const context = ctx();
    await reachVerify(h, context);

    await h.run('deploy', 'verify', context);

    expect(h.docker.runCli).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['--network', 'seamnex-inst-crm']),
      30_000,
    );
    expect(h.db.calls.some((call) => call.params[1] === 'ready')).toBe(true);
    expect(context.log).toHaveBeenCalledWith('stdout', '1 container(s) running');
  });

  it('fails at once on a container the daemon reports dead, quoting its last output', async () => {
    const h = setup();
    h.docker.inspect.mockResolvedValue(inspected({ Status: 'dead', ExitCode: 137 }) as never);
    h.docker.logs.mockResolvedValue('boom: bad config\n\nsecond line\n');
    const context = ctx();
    await reachVerify(h, context);

    await expect(h.run('deploy', 'verify', context)).rejects.toMatchObject({
      code: 'INTEGRATION_CHECK_FAILED',
      detail: expect.stringContaining('crm-app-1 cannot become ready: the daemon reports it dead.'),
      remediation: expect.stringContaining('Read the container output above'),
    });
    expect(context.log).toHaveBeenCalledWith('stderr', 'boom: bad config');
    expect(context.log).toHaveBeenCalledWith('stderr', 'second line');
  });

  it('survives a container that cannot be logged', async () => {
    const h = setup();
    h.docker.inspect.mockResolvedValue(inspected({ Status: 'dead' }) as never);
    h.docker.logs.mockRejectedValue(new Error('no such container'));
    const context = ctx();
    await reachVerify(h, context);

    await expect(h.run('deploy', 'verify', context)).rejects.toMatchObject({
      code: 'INTEGRATION_CHECK_FAILED',
    });
    // Only the guard's own line, because the tail could not be read.
    expect(context.log).toHaveBeenCalledWith(
      'stderr',
      'crm-app-1 cannot become ready: the daemon reports it dead.',
    );
  });

  it('fails a container that keeps restarting instead of waiting out the budget', async () => {
    vi.useFakeTimers();
    const h = setup();
    // The baseline is this stage's first look: only the delta proves a container is crash-looping.
    let looks = 0;
    h.docker.inspect.mockImplementation(async () => {
      looks += 1;
      return { State: { Status: 'running' }, RestartCount: (looks - 1) * 3 } as never;
    });
    h.docker.runCli.mockResolvedValue({ code: 1, stdout: '', stderr: '', truncated: false });
    const context = ctx();
    await reachVerify(h, context);

    await expect(settle(h.run('deploy', 'verify', context))).rejects.toMatchObject({
      detail: expect.stringContaining('it restarted 3 time(s) while this stage waited'),
    });
  });

  it('fails a container that stays exited', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.docker.inspect.mockResolvedValue(inspected({ Status: 'exited', ExitCode: 1 }) as never);
    const context = ctx();
    await reachVerify(h, context);

    await expect(settle(h.run('deploy', 'verify', context))).rejects.toMatchObject({
      detail: expect.stringContaining('it exited (code 1) and did not come back'),
    });
  });

  it('fails a container that stays unhealthy past its grace', async () => {
    vi.useFakeTimers();
    const h = setup([], { SEAMNEX_VERIFY_UNHEALTHY_GRACE_MS: 3_000 });
    h.docker.inspect.mockResolvedValue({
      State: { Status: 'running', Health: { Status: 'unhealthy' } },
      RestartCount: 0,
    } as never);
    h.docker.runCli.mockResolvedValue({ code: 1, stdout: '', stderr: '', truncated: false });
    const context = ctx();
    await reachVerify(h, context);

    await expect(settle(h.run('deploy', 'verify', context))).rejects.toMatchObject({
      detail: expect.stringContaining('its healthcheck has failed for'),
    });
  });

  it('ignores an unhealthy status when the grace is disabled, and times out instead', async () => {
    vi.useFakeTimers();
    const h = setup([], { SEAMNEX_VERIFY_UNHEALTHY_GRACE_MS: 0, SEAMNEX_VERIFY_TIMEOUT_MS: 3_000 });
    h.docker.inspect.mockResolvedValue({
      State: { Status: 'running', Health: { Status: 'unhealthy' } },
      RestartCount: 0,
    } as never);
    h.docker.runCli.mockResolvedValue({ code: 1, stdout: '', stderr: '', truncated: false });
    const context = ctx();
    await reachVerify(h, context);

    await expect(settle(h.run('deploy', 'verify', context))).rejects.toMatchObject({
      code: 'INTEGRATION_CHECK_FAILED',
      detail: expect.stringContaining('did not become ready within 3 s'),
    });
  });

  it('times out immediately when the budget is zero, reporting what it saw', async () => {
    const h = setup([], { SEAMNEX_VERIFY_TIMEOUT_MS: 0 });
    const context = ctx();
    await reachVerify(h, context);

    await expect(h.run('deploy', 'verify', context)).rejects.toMatchObject({
      detail: expect.stringContaining('(1 container(s) observed)'),
    });
  });

  it('collapses a repeated probe failure into a heartbeat instead of a transcript', async () => {
    vi.useFakeTimers();
    const h = setup([], { SEAMNEX_VERIFY_TIMEOUT_MS: 90_000 });
    h.docker.runCli.mockResolvedValue({
      code: 1,
      stdout: 'HTTP 502 Bad Gateway',
      stderr: '',
      truncated: false,
    });
    const context = ctx();
    await reachVerify(h, context);

    await expect(settle(h.run('deploy', 'verify', context), 3_000, 40)).rejects.toMatchObject({
      code: 'INTEGRATION_CHECK_FAILED',
    });
    const lines = (
      context.log as unknown as { mock: { calls: [string, string][] } }
    ).mock.calls.map((call) => call[1]);
    // Written once, then at most once per minute with the attempt count appended.
    expect(lines.filter((line) => line.startsWith('1 container(s) running'))).toEqual([
      '1 container(s) running',
      '1 container(s) running (21 attempts)',
    ]);
    expect(lines.some((line) => line.includes('readiness probe'))).toBe(true);
  });

  it('reports a container that disappeared mid-inspect with its list state', async () => {
    const h = setup();
    h.docker.inspect.mockRejectedValue(new Error('no such container'));
    h.docker.containers.mockResolvedValue([
      container({ state: 'running', name: 'crm-app-1' }),
    ] as never);
    const context = ctx();
    await reachVerify(h, context);

    await h.run('deploy', 'verify', context);

    // The list still says running and the probe answers, so the disappearance is not a failure.
    expect(h.db.calls.some((call) => call.params[1] === 'ready')).toBe(true);
    expect(context.log).toHaveBeenCalledWith('stdout', '1 container(s) running');
  });

  it('counts the restarts of a container that appeared after the first poll from zero', async () => {
    vi.useFakeTimers();
    const h = setup();
    let polls = 0;
    h.docker.containers.mockImplementation(async () => {
      polls += 1;
      return (
        polls === 1
          ? [container({ id: 'c1' })]
          : [
              container({ id: 'c1' }),
              container({ id: 'c2', name: '/crm-worker-1', service: 'worker' }),
            ]
      ) as never;
    });
    h.docker.inspect.mockImplementation(async (id: string) => {
      // A container `apply` created during this stage has no baseline: its whole count is evidence.
      return { State: { Status: 'running' }, RestartCount: id === 'c2' ? 4 : 0 } as never;
    });
    h.docker.runCli.mockResolvedValue({ code: 1, stdout: '', stderr: '', truncated: false });
    const context = ctx();
    await reachVerify(h, context);

    await expect(settle(h.run('deploy', 'verify', context))).rejects.toMatchObject({
      detail: expect.stringContaining('crm-worker-1 cannot become ready'),
    });
  });

  it('treats an empty container list as nothing to be ready', async () => {
    const h = setup([], { SEAMNEX_VERIFY_TIMEOUT_MS: 0 });
    h.docker.containers.mockResolvedValue([] as never);
    const context = ctx();
    await reachVerify(h, context);

    await expect(h.run('deploy', 'verify', context)).rejects.toMatchObject({
      detail: expect.stringContaining('(0 container(s) observed)'),
    });
  });
});

describe('integrate', () => {
  it('materialises the route, registers the client and marks the instance ready', async () => {
    const h = setup();
    h.integration.runChecks.mockResolvedValue({
      checks: [
        { check: 'route', ok: true, detail: 'reachable' },
        { check: 'sso_login', ok: false, detail: 'no login yet' },
      ],
      ready: true,
      blocking: [],
      installPending: null,
    });
    const context = ctx();
    await h.run('deploy', 'resolve', context);

    await h.run('deploy', 'integrate', context);

    expect(h.integration.materialiseRoute).toHaveBeenCalledWith(INSTANCE_ID, {}, 'alice');
    expect(context.log).toHaveBeenCalledWith('stdout', 'route crm.seamnex.local (subdomain)');
    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      'identity client seamnex-crm (oidc, sync=applied)',
    );
    expect(context.log).toHaveBeenCalledWith('stdout', 'route: reachable');
    expect(context.log).toHaveBeenCalledWith('stderr', 'sso_login: no login yet');
    expect(h.db.calls.some((call) => call.params[1] === 'ready')).toBe(true);
    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      'integration checks passed; instance is ready',
    );
  });

  it('records a product that answers with its installer as degraded, not ready', async () => {
    // The observed incident: OrangeHRM answered `302 -> /installer/index.php/welcome`, every check was
    // non-blocking, and `integrate` overwrote the `degraded` verdict `verify` had recorded. The route
    // has to survive — it is the only way to finish the install in a browser — so this must not throw.
    const h = setup();
    h.integration.runChecks.mockResolvedValue({
      checks: [{ check: 'http', ok: false, detail: 'with the installer' }],
      ready: true,
      blocking: [],
      installPending: '/installer/index.php/welcome',
    });
    const context = ctx();
    await h.run('deploy', 'resolve', context);

    await h.run('deploy', 'integrate', context);

    const pushed = h.db.calls.filter((call) => call.sql.includes('INSERT INTO instance_status'));
    expect(pushed.some((call) => call.params[1] === 'ready')).toBe(false);
    const degraded = pushed.find((call) => call.params[1] === 'degraded');
    expect(String(degraded?.params[3])).toContain('/installer/index.php/welcome');
    expect(context.log).toHaveBeenCalledWith(
      'stderr',
      expect.stringContaining('the instance is not marked ready'),
    );
  });

  it('prints the path prefix of a sub-path route', async () => {
    const h = setup();
    h.integration.materialiseRoute.mockResolvedValue({
      host: 'crm.seamnex.local',
      pathPrefix: '/crm',
      publishModel: 'subpath',
      authMode: 'native',
      gated: false,
      published: true,
    } as never);
    const context = ctx();
    await h.run('deploy', 'resolve', context);

    await h.run('deploy', 'integrate', context);

    expect(context.log).toHaveBeenCalledWith('stdout', 'route crm.seamnex.local/crm (subpath)');
  });

  it('refuses to declare the instance ready when a blocking check failed', async () => {
    const h = setup();
    h.integration.runChecks.mockResolvedValue({
      checks: [],
      ready: false,
      blocking: ['route', 'sso_login'],
      installPending: null,
    });
    const context = ctx();
    await h.run('deploy', 'resolve', context);

    await expect(h.run('deploy', 'integrate', context)).rejects.toMatchObject({
      code: 'INTEGRATION_CHECK_FAILED',
      detail: 'Post-deploy integration checks failed: route; sso_login',
    });
    expect(h.db.calls.some((call) => call.params[1] === 'ready')).toBe(false);
  });
});

describe('record', () => {
  async function reachRecord(h: ReturnType<typeof setup>, context: PipelineContext): Promise<void> {
    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);
    await h.run('deploy', 'plan', context);
  }

  it('records the applied render set, the services, the digests and the audit row', async () => {
    const h = setup();
    h.docker.containers.mockResolvedValue([
      container({ id: 'c1', service: 'app', image: 'repo/crm:7.4' }),
      container({ id: 'c2', service: 'mariadb', image: 'mariadb:11' }),
    ] as never);
    const context = ctx();
    await reachRecord(h, context);

    await h.run('deploy', 'record', context);

    const services = h.db.calls.filter((call) => call.sql.includes('INSERT INTO instance_service'));
    expect(services.map((call) => call.params.slice(1, 3))).toEqual([
      ['app', 'primary'],
      ['mariadb', 'database'],
    ]);
    const payloadUpdate = h.db.calls.find((call) => call.sql.includes('jsonb_build_object'));
    // FR-1.7: the fourth bind is the version the applied image actually carries, so the instance
    // reports what is running rather than what was requested. The fifth is the id a local build
    // produced — null here, because this deployment pulls `repo/crm:7.4`.
    expect(payloadUpdate?.params).toEqual([INSTANCE_ID, 'rs-000000000001', 'compose', '7.4', null]);
    expect(h.db.calls.some((call) => call.sql.includes('UPDATE render_set SET applied_at'))).toBe(
      true,
    );
    expect(h.capacity.release).toHaveBeenCalledWith(INSTANCE_ID);
    expect(h.outbox.emit).toHaveBeenCalledWith(expect.anything(), {
      aggregateType: 'instance',
      aggregateId: INSTANCE_ID,
      eventType: 'registry.rebuild',
      payload: { reason: 'instance.ready' },
    });
    expect(h.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.deploy.succeeded',
        // AC-06: the trail names the confirmed version and the applied one. A deploy has no
        // confirmed upgrade version, and the artefact it applied went out as 7.4.
        detail: {
          jobId: 'job-1',
          renderSetId: 'rs-000000000001',
          planId: 'plan-000000000001',
          changes: 1,
          targetVersion: null,
          appliedVersion: '7.4',
        },
      }),
    );
    // The run is dropped once it has been recorded, so nothing can record it twice.
    await expect(h.run('deploy', 'record', context)).rejects.toThrow(
      'the pipeline state is missing',
    );
  });

  it('records a run that never rendered, without inventing a render set', async () => {
    const h = setup();
    const context = ctx({ action: 'export' });
    await h.run('deploy', 'resolve', context);

    await h.run('deploy', 'record', context);

    expect(h.db.calls.some((call) => call.sql.includes('INSERT INTO instance_service'))).toBe(
      false,
    );
    expect(h.db.calls.some((call) => call.sql.includes('UPDATE render_set SET applied_at'))).toBe(
      false,
    );
    expect(h.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ renderSetId: null, planId: null, changes: 0 }),
      }),
    );
  });

  it('falls back to the recorded source path when this run has no resolved source', async () => {
    const h = setup([['SELECT id FROM render_set', [{ id: 'rs-previous-1234' }]]]);
    h.renderer.load.mockResolvedValue(renderSetOf({ id: 'rs-previous-1234' }));
    const context = ctx({ action: 'rollback' });
    await h.run('rollback', 'resolve', context);

    await h.run('rollback', 'record', context);

    const payloadUpdate = h.db.calls.find((call) => call.sql.includes('jsonb_build_object'));
    expect(payloadUpdate?.params).toEqual([
      INSTANCE_ID,
      'rs-previous-1234',
      'compose',
      '7.4',
      null,
    ]);
  });

  it('records the id a local build produced as the instance image identity', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(
      renderSetOf({
        files: [
          {
            path: COMPOSE,
            sha256: 'd'.repeat(64),
            content:
              'services:\n  app:\n    image: seamnex/crm:1\n    build: .\n    expose:\n      - "80"\n',
          },
        ],
      }),
    );
    h.docker.build.mockResolvedValue(undefined);
    h.docker.imageId.mockResolvedValue(IMAGE_DIGEST);
    const context = ctx();
    await reachRecord(h, context);
    await h.run('deploy', 'build', context);

    await h.run('deploy', 'record', context);

    const payloadUpdate = h.db.calls.find((call) => call.sql.includes('jsonb_build_object'));
    // ADR-BE-40: a built artefact has no repository digest, and its id changes per build, so the
    // instance has to report the id this build produced. The catalogue's reference value is what the
    // overview used to show while the containers ran something else.
    expect(payloadUpdate?.params).toEqual([
      INSTANCE_ID,
      'rs-000000000001',
      'compose',
      '7.4',
      IMAGE_DIGEST,
    ]);
  });

  it('names the role of every service from what the service is, never from list order', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(
      renderSetOf({
        files: [
          {
            path: COMPOSE,
            sha256: 'e'.repeat(64),
            content: [
              'services:',
              '  app:',
              '    expose: ["80"]',
              '  mariadb:',
              '    image: mariadb:11',
              '  redis:',
              '    image: redis:7',
              '  elasticsearch:',
              '    image: elasticsearch:8',
              '  cron:',
              '    image: cron:1',
            ].join('\n'),
          },
        ],
      }),
    );
    h.docker.containers.mockResolvedValue(
      ['app', 'mariadb', 'redis', 'elasticsearch', 'cron'].map((service) =>
        container({ id: `c-${service}`, service }),
      ) as never,
    );
    h.docker.imageIdentity.mockRejectedValue(new Error('gone'));
    const context = ctx();
    await reachRecord(h, context);

    await h.run('deploy', 'record', context);

    const services = h.db.calls.filter((call) => call.sql.includes('INSERT INTO instance_service'));
    expect(services.map((call) => call.params[2])).toEqual([
      'primary',
      'database',
      'cache',
      'search',
      'worker',
    ]);
    // An image that cannot be inspected is recorded without a digest rather than failing the stage.
    expect(services.map((call) => call.params[4])).toEqual([null, null, null, null, null]);
  });

  it('leaves every service a worker when the definition cannot be parsed', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(
      renderSetOf({
        files: [{ path: COMPOSE, sha256: 'f'.repeat(64), content: 'app: [unclosed' }],
      }),
    );
    const context = ctx();
    await reachRecord(h, context);

    await h.run('deploy', 'record', context);

    const services = h.db.calls.filter((call) => call.sql.includes('INSERT INTO instance_service'));
    expect(services.map((call) => call.params[2])).toEqual(['worker']);
  });

  it.each([
    ['a scalar document', 'just-a-string'],
    ['an explicit null', 'null'],
  ])('treats %s as a definition without services', async (_label, content) => {
    const h = setup();
    h.renderer.render.mockResolvedValue(
      renderSetOf({ files: [{ path: COMPOSE, sha256: 'i'.repeat(64), content }] }),
    );
    const context = ctx();
    await reachRecord(h, context);

    await h.run('deploy', 'record', context);

    const services = h.db.calls.filter((call) => call.sql.includes('INSERT INTO instance_service'));
    expect(services.map((call) => call.params[2])).toEqual(['worker']);
  });

  it('falls back when the definition has no service map', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(
      renderSetOf({
        files: [
          { path: COMPOSE, sha256: 'g'.repeat(64), content: 'services: 3' },
          { path: 'other.yml', sha256: 'h'.repeat(64), content: 'nope' },
        ],
      }),
    );
    const context = ctx();
    await reachRecord(h, context);

    await h.run('deploy', 'record', context);

    const services = h.db.calls.filter((call) => call.sql.includes('INSERT INTO instance_service'));
    expect(services.map((call) => call.params[2])).toEqual(['worker']);
  });
});

describe('markFailed', () => {
  /** The last state the handler wrote, which is the only one it owns. */
  function failureStatuses(h: ReturnType<typeof setup>) {
    return h.db.calls.filter((call) => call.sql.includes('INSERT INTO instance_status'));
  }

  it('moves a transitional instance to failed and says why', async () => {
    const h = setup();
    const context = ctx();
    await h.run('deploy', 'resolve', context);

    await h.registry.failureHandler('deploy')!(context, new Error('compose up failed'));

    const update = h.db.calls
      .filter((call) => call.sql.includes('UPDATE instance SET state = $2'))
      .pop();
    expect(update?.params[1]).toBe('failed');
    expect(failureStatuses(h).pop()?.params).toEqual([
      INSTANCE_ID,
      'failed',
      false,
      'compose up failed',
    ]);
    expect(context.log).toHaveBeenCalledWith(
      'system',
      'job failed; instance crm moved from verifying to failed so an operator can act on it',
    );
    expect(h.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.deploy.failed',
        outcome: 'failure',
        // AC-06: a failed upgrade says which version it was trying to apply.
        detail: { jobId: 'job-1', fromState: 'verifying', targetVersion: null },
      }),
    );
  });

  it('falls back to the job instance when the run was never recorded', async () => {
    const h = setup();

    await h.registry.failureHandler('deploy')!(ctx({ jobId: 'unknown-job' }), 'apply refused');

    expect(failureStatuses(h).pop()?.params).toEqual([
      INSTANCE_ID,
      'failed',
      false,
      'apply refused',
    ]);
    expect(h.db.calls.some((call) => call.sql.includes('SELECT slug, state FROM instance'))).toBe(
      true,
    );
  });

  it('does nothing at all for a job with no instance and no run', async () => {
    const h = setup();

    await h.registry.failureHandler('deploy')!(
      ctx({ instanceId: '', jobId: 'unknown-job' }),
      'boom',
    );

    expect(h.db.calls).toHaveLength(0);
  });

  it.each([
    ['an Error', new Error('boom'), 'boom'],
    ['a string', 'boom', 'boom'],
    ['something else', { nested: true }, 'the deploy job failed'],
    ['nothing at all', undefined, 'the deploy job failed'],
  ])('records %s as the reason', async (_label, cause, expected) => {
    const h = setup();
    const context = ctx();
    await h.run('deploy', 'resolve', context);

    await h.registry.failureHandler('deploy')!(context, cause);

    expect(failureStatuses(h).pop()?.params[3]).toBe(expected);
  });

  it('leaves an instance that is already settled alone', async () => {
    const h = setup([['SELECT slug, state FROM instance', [{ slug: 'crm', state: 'ready' }]]]);
    const context = ctx();
    await h.run('deploy', 'resolve', context);

    await h.registry.failureHandler('deploy')!(context, new Error('late failure'));

    // `ready` is not transitional: a stage that failed after the work succeeded must not look broken.
    expect(failureStatuses(h)).toHaveLength(1);
    expect(h.audit.append).not.toHaveBeenCalled();
  });

  it('does nothing for an instance that no longer exists', async () => {
    const h = setup([['SELECT slug, state FROM instance', []]]);
    const context = ctx();
    await h.run('deploy', 'resolve', context);

    await h.registry.failureHandler('deploy')!(context, new Error('boom'));

    expect(failureStatuses(h)).toHaveLength(1);
    expect(h.audit.append).not.toHaveBeenCalled();
  });
});

describe('simpleAction', () => {
  it('starts every container and promotes the instance once the probe answers', async () => {
    const h = setup();
    h.docker.containers.mockResolvedValue([
      container({ id: 'c1', service: 'app' }),
      container({ id: 'c2', service: 'db' }),
    ] as never);
    const context = ctx({ action: 'start' });

    await h.run('start', 'apply', context);

    expect(h.docker.start).toHaveBeenCalledTimes(2);
    expect(context.log).toHaveBeenCalledWith('stdout', 'start issued to 2 container(s)');
    expect(context.log).toHaveBeenCalledWith('stdout', 'start completed for 2 container(s)');
    expect(h.db.calls.some((call) => call.params[1] === 'starting')).toBe(true);
    expect(h.db.calls.some((call) => call.params[1] === 'ready')).toBe(true);
    expect(context.log).toHaveBeenCalledWith('stdout', 'readiness probe passed; instance is ready');
  });

  it('stops every container and settles the instance as stopped', async () => {
    const h = setup();
    const context = ctx({ action: 'stop' });

    await h.run('stop', 'apply', context);

    expect(h.docker.stop).toHaveBeenCalledOnce();
    expect(h.docker.runCli).not.toHaveBeenCalled();
    expect(h.db.calls.some((call) => call.params[1] === 'stopping')).toBe(true);
    expect(h.db.calls.some((call) => call.params[1] === 'stopped')).toBe(true);
  });

  it('leaves a restarted instance degraded when the probe does not pass', async () => {
    const h = setup();
    h.docker.runCli.mockResolvedValue({ code: 1, stdout: '', stderr: '', truncated: false });
    const context = ctx({ action: 'restart' });

    await h.run('restart', 'apply', context);

    expect(h.docker.restart).toHaveBeenCalledOnce();
    expect(h.db.calls.some((call) => call.params[1] === 'restarting')).toBe(true);
    const degrade = h.db.calls.find(
      (call) => call.sql.includes('INSERT INTO instance_status') && call.params[1] === 'degraded',
    );
    expect(degrade?.params[3]).toBe(
      'containers started, but the readiness probe did not pass (restart)',
    );
    expect(context.log).toHaveBeenCalledWith(
      'stderr',
      'the product is not answering yet; the status sampler will confirm readiness',
    );
  });

  it('refuses an instance with no containers to act on', async () => {
    const h = setup();
    h.docker.containers.mockResolvedValue([] as never);

    await expect(h.run('stop', 'apply', ctx({ action: 'stop' }))).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'The instance has no containers to act on.',
    });
  });

  it('refuses to start an instance whose definition drifted', async () => {
    const h = setup([['instanceParamDrift', [{ drifted: true }]]]);

    await expect(h.run('start', 'apply', ctx({ action: 'start' }))).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'instances/crm/instance.yaml does not match its recorded hash.',
    });
  });

  it('names every service that refused to act, with its own error text', async () => {
    const h = setup();
    h.docker.containers.mockResolvedValue([
      container({ id: 'c1', service: 'app' }),
      container({ id: 'c2', service: 'db' }),
    ] as never);
    h.docker.stop
      .mockRejectedValueOnce(new Error('graceful stop timed out'))
      .mockRejectedValueOnce('driver gone');
    const context = ctx({ action: 'stop' });

    await expect(h.run('stop', 'apply', context)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'stop did not complete for app, db.',
    });
    expect(context.log).toHaveBeenCalledWith(
      'stderr',
      'stop failed for app: graceful stop timed out',
    );
    expect(context.log).toHaveBeenCalledWith('stderr', 'stop failed for db: driver gone');
  });
});

describe('delete', () => {
  it('brings the applied project down, removing the volumes when the data is destroyed', async () => {
    const h = setup();
    h.docker.networkEndpoints.mockResolvedValue([
      { id: 'edge', name: 'seamnex-traefik' },
      { id: 'c1', name: 'crm-app-1' },
    ] as never);
    h.docker.containers.mockImplementation(
      async (labels: readonly string[]) =>
        (labels[0]?.startsWith('com.docker.compose.project=') === true
          ? [container({ id: 'c1', name: 'crm-app-1' })]
          : [container({ id: 'c1', name: 'crm-app-1' })]) as never,
    );
    const context = ctx({ action: 'delete', payload: { dataRetention: 'delete' } });

    await h.run('delete', 'apply', context);

    expect(h.docker.composeDown).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'seamnex-crm' }),
      true,
    );
    // The edge leaves first; the project's own container stays for `down` to remove, and only the
    // post-`down` sweep detaches whatever is left.
    expect(h.docker.disconnectNetwork.mock.calls[0]).toEqual(['seamnex-inst-crm', 'edge']);
    expect(context.log).toHaveBeenCalledWith('stdout', 'seamnex-traefik left seamnex-inst-crm');
    expect(context.log).toHaveBeenCalledWith('stdout', 'crm-app-1 left seamnex-inst-crm');
    expect(h.docker.removeNetwork).toHaveBeenCalledWith('seamnex-inst-crm');
    expect(h.db.calls.some((call) => call.sql.includes('deleted_at = now()'))).toBe(true);
    expect(h.capacity.release).toHaveBeenCalledWith(INSTANCE_ID);
    expect(h.outbox.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ payload: { reason: 'instance.deleted' } }),
    );
    expect(context.log).toHaveBeenCalledWith('stdout', 'project removed; data retention: delete');
  });

  it('keeps the data by default and uses the newest render set when none was applied', async () => {
    const h = setup([['SELECT id FROM render_set', [{ id: 'rs-unapplied' }]]]);
    h.renderer.applied.mockResolvedValue(null);
    h.renderer.load.mockResolvedValue(renderSetOf({ id: 'rs-unapplied' }));
    const context = ctx({ action: 'delete' });

    await h.run('delete', 'apply', context);

    expect(h.renderer.load).toHaveBeenCalledWith('rs-unapplied');
    expect(h.docker.composeDown).toHaveBeenCalledWith(expect.anything(), false);
    expect(context.log).toHaveBeenCalledWith('stdout', 'project removed; data retention: keep');
  });

  it('still removes the network when there was never a render set', async () => {
    const h = setup();
    h.renderer.applied.mockResolvedValue(null);
    const context = ctx({ action: 'delete' });

    await h.run('delete', 'apply', context);

    expect(h.docker.composeDown).not.toHaveBeenCalled();
    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      'no render set recorded; there is no project to bring down',
    );
    expect(h.docker.removeNetwork).toHaveBeenCalledWith('seamnex-inst-crm');
  });

  it('logs a member that refuses to leave and carries on', async () => {
    const h = setup();
    h.docker.networkEndpoints.mockResolvedValue([
      { id: 'idp', name: 'seamnex-keycloak' },
      { id: 'odd', name: 'stray' },
    ] as never);
    h.renderer.applied.mockResolvedValue(renderSetOf({ id: 'rs-detach' }));
    h.docker.disconnectNetwork
      .mockRejectedValueOnce(new Error('endpoint is busy'))
      .mockRejectedValueOnce('unknown failure');
    const context = ctx({ action: 'delete' });

    await h.run('delete', 'apply', context);

    expect(context.log).toHaveBeenCalledWith(
      'stderr',
      'seamnex-keycloak could not leave seamnex-inst-crm: endpoint is busy',
    );
    expect(context.log).toHaveBeenCalledWith(
      'stderr',
      'stray could not leave seamnex-inst-crm: unknown failure',
    );
    expect(h.docker.removeNetwork).toHaveBeenCalled();
  });
});

/**
 * FR-1.13 / AC-20 — the capture, not a description of one.
 *
 * The helper containers are faked, and the fake writes real bytes into the mounted host directory:
 * a capture that "succeeded" without producing files would pass every other assertion here while
 * shipping an empty archive, which is the defect this suite replaces.
 */
describe('export', () => {
  // Every export test writes to the same instance directory; each starts from an empty one so the
  // sidecar it reads is the archive it just produced.
  beforeEach(() => {
    rmSync(join(DATA_DIR, INSTANCE_ID, 'exports'), { recursive: true, force: true });
    rmSync(join(DATA_DIR, 'archive-contents'), { recursive: true, force: true });
  });

  /** The mount a `-v` argument names, spelled `[host]:[container]` — Windows drive letters included. */
  const MOUNT = /^(.*):(\/[^:]*)(?::ro)?$/;

  function mountsOf(args: readonly string[]): { host: string; target: string }[] {
    const mounts: { host: string; target: string }[] = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] !== '-v') continue;
      const match = MOUNT.exec(args[index + 1] ?? '');
      if (match?.[1] !== undefined && match[2] !== undefined) {
        mounts.push({ host: match[1], target: match[2] });
      }
    }
    return mounts;
  }

  function hostPathOf(args: readonly string[], containerPath: string): string | null {
    for (const mount of mountsOf(args)) {
      if (containerPath === mount.target) return mount.host;
      if (containerPath.startsWith(`${mount.target}/`)) {
        return join(mount.host, containerPath.slice(mount.target.length + 1));
      }
    }
    return null;
  }

  /** What the helper containers do on a real host: write the dump, then pack the staging tree. */
  function fakeHelpers(docker: { runCli: unknown }, options: { dumpFails?: boolean } = {}): void {
    (docker.runCli as { mockImplementation: (fn: unknown) => void }).mockImplementation(
      async (_file: string, args: readonly string[]) => {
        // The dump runs through `sh -c`, so its target is inside the command string, not an argument.
        const dumpTarget = /--file=(\S+)/.exec(args.join(' '));
        if (dumpTarget?.[1] !== undefined) {
          if (options.dumpFails === true) {
            return { code: 1, stdout: '', stderr: 'could not connect to server', truncated: false };
          }
          const target = hostPathOf(args, dumpTarget[1]);
          if (target !== null) writeFileSync(target, 'CREATE TABLE crm (id integer);\n');
        }

        const tarIndex = args.indexOf('-czf');
        if (tarIndex !== -1) {
          // Snapshot the staging tree before it is removed: the archive's contents are asserted from
          // it, and the fake tar cannot be read back.
          const source = hostPathOf(args, args[args.indexOf('-C') + 1] ?? '/src');
          // A volume archive's source is a named volume, not a host path; only the staging tree is
          // snapshot, and only while it is still there.
          if (source !== null && existsSync(source)) {
            rmSync(join(DATA_DIR, 'archive-contents'), { recursive: true, force: true });
            cpSync(source, join(DATA_DIR, 'archive-contents'), { recursive: true });
          }
          const target = hostPathOf(args, args[tarIndex + 1] ?? '');
          if (target !== null) writeFileSync(target, 'fake-tar-bytes');
        }
        return { code: 0, stdout: '', stderr: '', truncated: false };
      },
    );
  }

  function renderDirectory(): string {
    const directory = join(DATA_DIR, 'render', 'rs-000000000001');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, COMPOSE), 'services:\n  db:\n    image: postgres:16-alpine\n');
    writeFileSync(join(directory, 'platform.env'), 'INSTANCE_SLUG=crm\n');
    return directory;
  }

  function exportFiles(): { sidecar: Record<string, unknown>; exportId: string } {
    const directory = join(DATA_DIR, INSTANCE_ID, 'exports');
    const archive = readdirSync(directory).find((name) => name.endsWith('.tar.gz'));
    expect(archive).toBeDefined();
    const exportId = String(archive).replace(/\.tar\.gz$/, '');
    const sidecar = JSON.parse(readFileSync(join(directory, `${exportId}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    return { sidecar, exportId };
  }

  it('captures the database, the volumes, the definition and a manifest into one archive', async () => {
    const h = setup([
      ['SELECT i.id, i.entry_key, i.slug, i.domain_route', [{ ...INSTANCE_ROW, state: 'ready' }]],
      ['FROM instance_service', [{ service_name: 'db', image_ref: 'postgres:16-alpine' }]],
      ['FROM instance_volume', [{ name: 'seamnex-crm-db-data' }]],
      [
        'FROM instance_env_value',
        [
          {
            var_name: 'DATABASE_URL',
            value_enc: Buffer.from('postgres://postgres@db:5432/crm'),
            source: 'instance',
            secret_ref: null,
          },
          {
            var_name: 'SMTP_PASSWORD',
            value_enc: null,
            source: 'secret',
            secret_ref: 'secret://crm/smtp',
          },
          // An unset non-secret variable is not a credential: it must not be reported as one.
          { var_name: 'SMTP_USERNAME', value_enc: null, source: 'instance', secret_ref: null },
        ],
      ],
    ]);
    h.renderer.applied.mockResolvedValue(renderSetOf({ directory: renderDirectory() }));
    fakeHelpers(h.docker);
    const context = ctx({ action: 'export' });

    await h.run('export', 'apply', context);
    await h.run('export', 'record', context);

    const { sidecar, exportId } = exportFiles();
    expect(sidecar).toMatchObject({
      version: 1,
      exportId,
      instance: { id: INSTANCE_ID, slug: 'crm', entryKey: 'D01-01', state: 'ready' },
      renderSet: { id: 'rs-000000000001', contentHash: 'hash-1', applied: true },
      includes: ['database', 'volumes', 'definition', 'environment'],
    });
    expect((sidecar.files as { path: string }[]).map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'database/db.sql',
        'volumes/seamnex-crm-db-data.tar.gz',
        'render/docker-compose.platform.yml',
        'render/platform.env',
        'instance/env.json',
        'README.txt',
      ]),
    );
    for (const file of sidecar.files as { sha256: string }[]) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(sidecar.archive).toMatchObject({
      fileName: `${exportId}.tar.gz`,
      bytes: Buffer.byteLength('fake-tar-bytes'),
    });

    // Secrets are named, never carried.
    const env = JSON.parse(
      readFileSync(join(DATA_DIR, 'archive-contents', 'instance', 'env.json'), 'utf8'),
    ) as { values: { name: string; value: string | null }[]; secretNames: string[] };
    expect(env.values).toEqual(
      expect.arrayContaining([
        { name: 'DATABASE_URL', source: 'instance', value: 'postgres://postgres@db:5432/crm' },
        { name: 'SMTP_PASSWORD', source: 'secret', value: null },
      ]),
    );
    expect(env.secretNames).toEqual(['SMTP_PASSWORD']);

    // The staging tree held a plaintext copy of the database; the archive is the artefact.
    expect(
      readdirSync(join(DATA_DIR, INSTANCE_ID, 'exports')).some((n) => n.startsWith('.staging-')),
    ).toBe(false);

    // AC-20 evidence: the audit row names the artefact a reviewer can go and fetch.
    expect(h.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.export.succeeded',
        detail: expect.objectContaining({
          exportId,
          fileName: `${exportId}.tar.gz`,
          includes: ['database', 'volumes', 'definition', 'environment'],
        }),
      }),
    );
    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      expect.stringContaining(`export ${exportId} written`),
    );
  });

  it('marks a render set that never ran, instead of implying it is what the product runs', async () => {
    const h = setup([['FROM render_set WHERE instance_id', [{ id: 'rs-000000000001' }]]]);
    // The deployment failed before `apply` recorded an applied set.
    h.renderer.applied.mockResolvedValue(null);
    fakeHelpers(h.docker);
    const context = ctx({ action: 'export' });

    await h.run('export', 'apply', context);

    expect(exportFiles().sidecar.renderSet).toEqual({
      id: 'rs-000000000001',
      contentHash: 'hash-1',
      applied: false,
    });
  });

  it('refuses an instance that was never deployed instead of writing a metadata-only file', async () => {
    const h = setup();
    h.renderer.applied.mockResolvedValue(null);
    const context = ctx({ action: 'export' });

    await expect(h.run('export', 'apply', context)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'crm has never been deployed, so there is no data to export.',
    });
    expect(h.docker.runCli).not.toHaveBeenCalled();
  });

  it('refuses a stopped instance whose database cannot be dumped', async () => {
    const h = setup([
      ['SELECT i.id, i.entry_key, i.slug, i.domain_route', [{ ...INSTANCE_ROW, state: 'stopped' }]],
      ['FROM instance_service', [{ service_name: 'db', image_ref: 'postgres:16-alpine' }]],
    ]);
    const context = ctx({ action: 'export' });

    await expect(h.run('export', 'apply', context)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: expect.stringContaining('cannot be dumped while the instance is not running'),
    });
    // Refused before the first helper ran: nothing was written and nothing was left behind.
    expect(h.docker.runCli).not.toHaveBeenCalled();
  });

  it('names a volume the daemon no longer holds instead of failing the whole export', async () => {
    const h = setup([['FROM instance_volume', [{ name: 'seamnex-crm-db-data' }]]]);
    h.renderer.applied.mockResolvedValue(renderSetOf({ directory: renderDirectory() }));
    h.docker.volumeExists.mockResolvedValue(false);
    fakeHelpers(h.docker);
    const context = ctx({ action: 'export' });

    await h.run('export', 'apply', context);

    const { sidecar } = exportFiles();
    expect(sidecar.includes).not.toContain('volumes');
    expect(sidecar.excluded).toEqual(
      expect.arrayContaining([expect.objectContaining({ item: 'volumes/seamnex-crm-db-data' })]),
    );
    expect(context.log).toHaveBeenCalledWith(
      'system',
      'volume seamnex-crm-db-data is registered but absent from the daemon; not captured',
    );
  });

  it('fails the capture, and keeps nothing, when the database dump fails', async () => {
    const h = setup([
      ['SELECT i.id, i.entry_key, i.slug, i.domain_route', [{ ...INSTANCE_ROW, state: 'ready' }]],
      ['FROM instance_service', [{ service_name: 'db', image_ref: 'postgres:16-alpine' }]],
    ]);
    h.renderer.applied.mockResolvedValue(renderSetOf({ directory: renderDirectory() }));
    fakeHelpers(h.docker, { dumpFails: true });
    const directory = join(DATA_DIR, INSTANCE_ID, 'exports');
    const before = existsSync(directory) ? readdirSync(directory).length : 0;
    const context = ctx({ action: 'export' });

    await expect(h.run('export', 'apply', context)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: expect.stringContaining('db (postgres) could not be dumped'),
    });
    // No artefact and no staging tree: a listed archive that holds no data is the defect.
    const left = existsSync(directory) ? readdirSync(directory) : [];
    expect(left).toHaveLength(before);
    expect(left.filter((name) => name.startsWith('.staging-'))).toHaveLength(0);
  });
});

describe('prepull', () => {
  it('pulls the pinned image the catalog declares', async () => {
    const h = setup([
      ['SELECT payload FROM catalog_entry', [{ payload: { imageRef: 'repo/crm:7.4' } }]],
    ]);
    const context = ctx({ action: 'prepull', payload: { entryKey: 'D01-01' } });

    await h.run('prepull', 'resolve', context);

    expect(context.log).toHaveBeenCalledWith('stdout', 'pulling repo/crm:7.4');
    expect(h.docker.pull).toHaveBeenCalledWith(
      'repo/crm:7.4',
      expect.any(Function),
      expect.anything(),
    );
  });

  it('pulls nothing for an entry that declares no image', async () => {
    const h = setup([['SELECT payload FROM catalog_entry', [{ payload: {} }]]]);

    await h.run('prepull', 'resolve', ctx({ action: 'prepull', payload: { entryKey: 'D01-01' } }));

    expect(h.docker.pull).not.toHaveBeenCalled();
  });

  it('pulls nothing when the catalog row holds no payload at all', async () => {
    const h = setup([['SELECT payload FROM catalog_entry', [{}]]]);

    await h.run('prepull', 'resolve', ctx({ action: 'prepull', payload: { entryKey: 'D01-01' } }));

    expect(h.docker.pull).not.toHaveBeenCalled();
    expect(h.docker.repoDigest).not.toHaveBeenCalled();
  });

  it('refuses a job with no entry key instead of resolving the empty catalog entry', async () => {
    const h = setup();

    await expect(
      h.run('prepull', 'resolve', ctx({ action: 'prepull', jobId: 'job-2' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(h.docker.pull).not.toHaveBeenCalled();
  });

  it('builds a vendored tree instead of pulling the tag it names', async () => {
    const mirror = resolve(DATA_DIR, 'mirror');
    const tree = join(mirror, 'D07-01');
    mkdirSync(tree, { recursive: true });
    writeFileSync(
      join(tree, 'docker-compose.yml'),
      'services:\n  app:\n    image: seamnex/orangehrm:5.9\n    build:\n      context: .\n',
    );
    writeFileSync(join(tree, 'Dockerfile'), 'FROM scratch\n');
    try {
      const h = setup([], { SEAMNEX_SOURCE_MIRROR_DIR: mirror });
      const context = ctx({ action: 'prepull', payload: { entryKey: 'D07-01' } });

      await h.run('prepull', 'resolve', context);

      expect(h.docker.build).toHaveBeenCalledWith({
        context: tree,
        dockerfile: join(tree, 'Dockerfile'),
        tag: 'seamnex/orangehrm:5.9',
      });
      // The whole point: the artefact is produced, so nothing is fetched and nothing can contradict it.
      expect(h.docker.pull).not.toHaveBeenCalled();
      expect(context.log).toHaveBeenCalledWith(
        'stdout',
        `seamnex/orangehrm:5.9 built as ${IMAGE_DIGEST}; this entry is never pulled`,
      );
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('refuses a declared build whose context is missing, instead of falling back to a pull', async () => {
    const mirror = resolve(DATA_DIR, 'mirror-missing');
    const tree = join(mirror, 'D07-02');
    mkdirSync(tree, { recursive: true });
    writeFileSync(
      join(tree, 'docker-compose.yml'),
      'services:\n  app:\n    image: seamnex/other:1\n    build:\n      context: ./absent\n',
    );
    try {
      const h = setup([], { SEAMNEX_SOURCE_MIRROR_DIR: mirror });

      await expect(
        h.run('prepull', 'resolve', ctx({ action: 'prepull', payload: { entryKey: 'D07-02' } })),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(h.docker.pull).not.toHaveBeenCalled();
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('refuses a pull whose tag no longer resolves to the pinned digest', async () => {
    const h = setup([
      [
        'SELECT payload FROM catalog_entry',
        [{ payload: { imageRef: 'repo/crm:7.4', imageDigest: IMAGE_DIGEST } }],
      ],
    ]);
    h.docker.repoDigest.mockResolvedValue(`sha256:${'c'.repeat(64)}`);

    await expect(
      h.run('prepull', 'resolve', ctx({ action: 'prepull', payload: { entryKey: 'D01-01' } })),
    ).rejects.toMatchObject({
      code: 'IMAGE_DIGEST_MISMATCH',
      detail: expect.stringContaining('repo/crm:7.4'),
    });
  });

  it('records the match when the pulled image is the pinned one', async () => {
    const h = setup([
      [
        'SELECT payload FROM catalog_entry',
        [{ payload: { imageRef: 'repo/crm:7.4', imageDigest: IMAGE_DIGEST } }],
      ],
    ]);
    const context = ctx({ action: 'prepull', payload: { entryKey: 'D01-01' } });

    await h.run('prepull', 'resolve', context);

    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      `repo/crm:7.4 matches the pinned digest ${IMAGE_DIGEST}`,
    );
  });

  it('refuses to pull while the Docker adapter is switched off', async () => {
    const h = setup([], { SEAMNEX_ADAPTERS_MODE: 'disabled' });

    await expect(
      h.run('prepull', 'resolve', ctx({ action: 'prepull', payload: { entryKey: 'D01-01' } })),
    ).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
  });
});

describe('build', () => {
  it('builds the image reference the job asks for', async () => {
    const h = setup();
    h.sources.resolve.mockResolvedValue(
      sourceOf({
        path: 'dockerfile',
        directory: '/work/crm',
        dockerfilePath: '/work/crm/Dockerfile',
      }) as never,
    );
    const context = ctx({ action: 'build', payload: { imageRef: 'repo/crm:dev' } });
    await h.run('deploy', 'resolve', context);

    await h.run('build', 'apply', context);

    expect(h.docker.build).toHaveBeenCalledWith({
      context: '/work/crm',
      dockerfile: '/work/crm/Dockerfile',
      tag: 'repo/crm:dev',
      labels: { 'seamnex.instance': INSTANCE_ID, 'seamnex.entry': 'D01-01' },
    });
  });

  it('refuses a build job with no image reference', async () => {
    const h = setup();
    const context = ctx({ action: 'build' });
    await h.run('deploy', 'resolve', context);

    await expect(h.run('build', 'apply', context)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'A build needs an image reference and a Dockerfile.',
    });
  });

  it('refuses a build for a source that has no Dockerfile', async () => {
    const h = setup([['SELECT id FROM render_set', [{ id: 'rs-previous-1234' }]]]);
    const context = ctx({ action: 'build', payload: { imageRef: 'repo/crm:dev' } });
    await h.run('rollback', 'resolve', context);

    // A rollback resolves a render set, not a source: there is no Dockerfile to build.
    await expect(h.run('build', 'apply', context)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
  });

  it('refuses a build that never resolved', async () => {
    const { run } = setup();

    await expect(
      run('build', 'apply', ctx({ action: 'build', payload: { imageRef: 'repo/crm:dev' } })),
    ).rejects.toThrow('the pipeline state is missing');
  });
});

describe('recordLifecycle', () => {
  it('audits the action against the instance the run touched', async () => {
    const h = setup();
    const context = ctx({ action: 'stop' });
    await h.run('stop', 'apply', context);

    await h.run('stop', 'record', context);

    expect(h.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.stop.succeeded',
        targetId: INSTANCE_ID,
        detail: { jobId: 'job-1' },
      }),
    );
  });

  it('falls back to the job instance when the run was never recorded', async () => {
    const h = setup();

    await h.run('export', 'record', ctx({ action: 'export', jobId: 'job-unrecorded' }));

    expect(h.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'instance.export.succeeded', targetId: INSTANCE_ID }),
    );
  });
});

describe('setState', () => {
  it('writes the state with the reason, and clears the reason when there is none', async () => {
    const h = setup();
    const context = ctx();
    await h.run('deploy', 'resolve', context);

    const status = h.db.calls.filter((call) => call.sql.includes('INSERT INTO instance_status'));
    expect(status[0]?.params).toEqual([INSTANCE_ID, 'resolving', false, null]);
  });

  it('marks the instance ready in the status projection only when it is ready', async () => {
    const h = setup();
    const context = ctx();
    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);
    await h.run('deploy', 'plan', context);
    await h.run('deploy', 'record', context);

    const statuses = h.db.calls
      .filter((call) => call.sql.includes('INSERT INTO instance_status'))
      .map((call) => [call.params[1], call.params[2]]);
    expect(statuses).toContainEqual(['ready', true]);
    expect(statuses).toContainEqual(['resolving', false]);
  });

  it('refuses to project a run whose state is missing', async () => {
    const h = setup();
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, 'exists.txt'), 'x');

    await expect(h.run('deploy', 'record', ctx({ jobId: 'never-resolved' }))).rejects.toThrow(
      'the pipeline state is missing; a stage ran out of order',
    );
  });
});

describe('the registered stage lists', () => {
  it('walks an upgrade through backup, apply, verify, integrate and record', async () => {
    const h = setup();
    const context = ctx({ action: 'upgrade', payload: { backupJobId: 'job-backup' } });

    for (const name of [
      'resolve',
      'render',
      'plan',
      'backup',
      'build',
      'apply',
      'verify',
      'integrate',
      'record',
    ]) {
      await h.run('upgrade', name, context);
    }

    expect(h.jobs.get).toHaveBeenCalledWith('job-backup');
    expect(h.docker.composeUp).toHaveBeenCalled();
    expect(h.db.calls.some((call) => call.params[1] === 'ready')).toBe(true);
    expect(h.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'instance.upgrade.succeeded' }),
    );
  });

  it('walks a rollback through apply, verify and record without a resolved source', async () => {
    const h = setup([['SELECT id FROM render_set', [{ id: 'rs-previous-1234' }]]]);
    h.renderer.load.mockResolvedValue(renderSetOf({ id: 'rs-previous-1234' }));
    const context = ctx({ action: 'rollback' });

    for (const name of ['resolve', 'plan', 'apply', 'verify', 'record']) {
      await h.run('rollback', name, context);
    }

    expect(h.docker.composeUp).toHaveBeenCalled();
    expect(h.docker.build).not.toHaveBeenCalled();
    expect(h.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'instance.rollback.succeeded' }),
    );
  });

  it('records a delete and a build artefact through the lifecycle recorder', async () => {
    const h = setup();
    const deletion = ctx({ action: 'delete' });
    await h.run('delete', 'apply', deletion);
    await h.run('delete', 'record', deletion);

    expect(h.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'instance.delete.succeeded', targetId: INSTANCE_ID }),
    );

    const source = setup();
    source.sources.resolve.mockResolvedValue(
      sourceOf({
        path: 'dockerfile',
        directory: '/work/crm',
        dockerfilePath: '/work/crm/Dockerfile',
      }) as never,
    );
    const build = ctx({ action: 'build', payload: { imageRef: 'repo/crm:dev' } });
    await source.run('deploy', 'resolve', build);
    await source.run('build', 'apply', build);
    await source.run('build', 'record', build);

    expect(source.docker.build).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'repo/crm:dev' }),
    );
    expect(source.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'instance.build.succeeded' }),
    );
  });
});

/**
 * FR-1.7 / AC-06 — the confirmed upgrade target is re-asserted against the catalogue at job time.
 *
 * The dialog read the pin minutes before the job started; a catalogue that moved in between must
 * stop the upgrade rather than deploy whatever the entry holds now.
 */
describe('upgrade target version', () => {
  const LATEST_QUERY = "payload #>> '{upstream,latestVersion}'";

  it('re-asserts a confirmed target that the catalogue still pins', async () => {
    const h = setup([[LATEST_QUERY, [{ latest: '9.2.1' }]]]);
    const context = ctx({ action: 'upgrade', payload: { targetVersion: '9.2.1' } });

    await h.run('upgrade', 'resolve', context);

    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      'confirmed upgrade target 9.2.1 still matches the catalogue pin',
    );
    expect(h.sources.resolve).toHaveBeenCalled();
  });

  it('refuses an upgrade whose confirmed version the catalogue no longer pins', async () => {
    const h = setup([[LATEST_QUERY, [{ latest: '9.2.2' }]]]);
    const context = ctx({ action: 'upgrade', payload: { targetVersion: '9.2.1' } });

    await expect(h.run('upgrade', 'resolve', context)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'The catalogue now pins 9.2.2, not the confirmed 9.2.1.',
    });
    // The refusal is before the cost of a resolve: nothing was cloned and nothing was applied.
    expect(h.sources.resolve).not.toHaveBeenCalled();
  });

  it('refuses an upgrade when the catalogue records no upstream version at all', async () => {
    const h = setup([[LATEST_QUERY, [{ latest: null }]]]);
    const context = ctx({ action: 'upgrade', payload: { targetVersion: '9.2.1' } });

    await expect(h.run('upgrade', 'resolve', context)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: expect.stringContaining('records no upstream version'),
    });
  });

  it('asks the catalogue nothing when there is no confirmed upgrade target', async () => {
    const cases: PipelineContext[] = [
      // A deploy may carry a version, but only an upgrade promises a target.
      ctx({ payload: { targetVersion: '9.2.1' } }),
      ctx({ action: 'upgrade' }),
      ctx({ action: 'upgrade', payload: { targetVersion: '' } }),
    ];

    for (const context of cases) {
      const h = setup();
      const kind = context.action === 'upgrade' ? 'upgrade' : 'deploy';

      await h.run(kind, 'resolve', context);

      expect(h.db.calls.some((call) => call.sql.includes('upstream,latestVersion'))).toBe(false);
      expect(h.sources.resolve).toHaveBeenCalled();
    }
  });
});

describe('apply image evidence', () => {
  async function reachApply(h: ReturnType<typeof setup>, context: PipelineContext): Promise<void> {
    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);
  }

  it('scans the images the applied definition names, skipping files it cannot read', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(
      renderSetOf({
        files: [
          // Not a compose document: `platform.env` is carried in the same set but names no image.
          { path: 'platform.env', sha256: 'a'.repeat(64), content: 'INSTANCE_SLUG=crm\n' },
          // A half-written document must not fail the stage; the readable one still names its image.
          { path: 'broken.yml', sha256: 'b'.repeat(64), content: 'app: [unclosed' },
          {
            path: COMPOSE,
            sha256: 'c'.repeat(64),
            content: 'services:\n  app:\n    image: repo/crm:7.4\n    expose:\n      - "80"\n',
          },
        ],
      }),
    );
    h.images.scanForDeploy.mockImplementation(async (input) => {
      await input.log?.('stdout', 'scanning the images this deployment will start');
      return [scanSummary('repo/crm:7.4', 'passed')] as never;
    });
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(h.images.scanForDeploy).toHaveBeenCalledWith({
      instanceId: INSTANCE_ID,
      references: ['repo/crm:7.4'],
      log: expect.any(Function),
    });
    expect(context.log).toHaveBeenCalledWith('system', '1 image(s) scanned; no blocking findings');
    // Whatever the scanner says reaches the job log at the level it chose.
    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      'scanning the images this deployment will start',
    );
    expect(h.docker.composeUp).toHaveBeenCalled();
  });

  it('pulls a sidecar image before the scan asks the daemon about it', async () => {
    const h = setup();
    const pinned = `mariadb:11.4.13@sha256:${'e'.repeat(64)}`;
    h.renderer.render.mockResolvedValue(
      renderSetOf({
        files: [
          {
            path: COMPOSE,
            sha256: 'c'.repeat(64),
            content:
              'services:\n  app:\n    image: repo/crm:7.4\n    expose:\n      - "80"\n' +
              `  db:\n    image: ${pinned}\n`,
          },
        ],
      }),
    );
    // A host that has never fetched the sidecar: the shape D01-01's first deployment met, where the
    // scan reached the daemon before `compose up` could pull it and reported `404 no such image`.
    h.docker.imageExists.mockImplementation(async (ref: string) => ref !== pinned);
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(h.docker.pull).toHaveBeenCalledWith(pinned, expect.any(Function), {
      // The reference names its own digest, so the pull is where that pin is checked.
      expectedDigest: `sha256:${'e'.repeat(64)}`,
    });
    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      `${pinned} is not present locally; pulling it before the scan`,
    );
    expect(h.docker.pull.mock.invocationCallOrder[0]).toBeLessThan(
      h.images.scanForDeploy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('does not summarise an unscannable image as "no blocking findings"', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(
      renderSetOf({
        files: [
          {
            path: COMPOSE,
            sha256: 'c'.repeat(64),
            content: 'services:\n  app:\n    image: repo/crm:7.4\n    expose:\n      - "80"\n',
          },
        ],
      }),
    );
    // Fail-open: the deployment continued, but calling that a clean scan would be the S-10 defect.
    h.images.scanForDeploy.mockResolvedValue([scanSummary('repo/crm:7.4', 'error')] as never);
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(context.log).toHaveBeenCalledWith(
      'system',
      '1 image(s) examined: 0 passed, 0 blocked, 1 not scanned',
    );
    expect(context.log).not.toHaveBeenCalledWith(
      'system',
      '1 image(s) scanned; no blocking findings',
    );
    expect(h.docker.composeUp).toHaveBeenCalled();
  });

  it('says how many images passed when only some could be scanned', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(
      renderSetOf({
        files: [
          {
            path: COMPOSE,
            sha256: 'c'.repeat(64),
            content:
              'services:\n  app:\n    image: repo/crm:7.4\n    expose:\n      - "80"\n  db:\n    image: mariadb:11.4\n',
          },
        ],
      }),
    );
    h.images.scanForDeploy.mockResolvedValue([
      scanSummary('repo/crm:7.4', 'passed'),
      scanSummary('mariadb:11.4', 'error'),
    ] as never);
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(context.log).toHaveBeenCalledWith(
      'system',
      '2 image(s) examined: 1 passed, 0 blocked, 1 not scanned',
    );
    expect(h.docker.composeUp).toHaveBeenCalled();
  });

  it('skips the registry comparison for a source that names no pinned image', async () => {
    const h = setup();
    h.sources.resolve.mockResolvedValue(sourceOf({ imageRef: null, imageDigest: null }) as never);
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(h.docker.repoDigest).not.toHaveBeenCalled();
    expect(h.docker.imageExists).not.toHaveBeenCalled();
    expect(h.docker.composeUp).toHaveBeenCalled();
  });

  it('accepts a reference that pins its own digest without asking the daemon', async () => {
    const reference = `repo/crm@sha256:${'a'.repeat(64)}`;
    const h = setup();
    h.sources.resolve.mockResolvedValue(sourceOf({ imageRef: reference }) as never);
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      `${reference} pins its digest in the reference`,
    );
    expect(h.docker.repoDigest).not.toHaveBeenCalled();
    expect(h.docker.composeUp).toHaveBeenCalled();
  });

  it('refuses to build before the definition exists', async () => {
    const h = setup();
    const context = ctx();
    // `resolve` records the run; nothing has rendered into it, so there is no definition to build.
    await h.run('deploy', 'resolve', context);

    await expect(h.run('deploy', 'build', context)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'The build stage ran before the definition existed.',
    });
    expect(h.docker.composeBuild).not.toHaveBeenCalled();
    expect(h.docker.build).not.toHaveBeenCalled();
  });

  it('names a build service that declares no image, and skips it when the pin is checked', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(
      renderSetOf({
        files: [
          {
            path: COMPOSE,
            sha256: 'd'.repeat(64),
            content: [
              'services:',
              '  app:',
              '    image: seamnex/crm:1',
              '    build: .',
              '  worker:',
              '    build:',
              '      context: .',
            ].join('\n'),
          },
        ],
      }),
    );
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'build', context);

    expect(context.log).toHaveBeenCalledWith(
      'system',
      'worker declares build: without image:, so the artefact has no name the platform can pin; the definition should declare both',
    );
    expect(context.log).toHaveBeenCalledWith('stdout', `seamnex/crm:1 built as ${IMAGE_DIGEST}`);

    await h.run('deploy', 'apply', context);

    // Only the named artefact is compared: a service with no `image:` has nothing to compare.
    expect(h.docker.imageId).toHaveBeenCalledWith('seamnex/crm:1');
    expect(h.docker.imageId).not.toHaveBeenCalledWith(expect.stringContaining('worker'));
    expect(h.docker.composeUp).toHaveBeenCalled();
  });

  it('records a rebuild that produced a different id as the new baseline', async () => {
    const h = setup([
      [
        'FROM instance_service',
        [{ service_name: 'app', image_digest: `sha256:${'e'.repeat(64)}` }],
      ],
    ]);
    h.renderer.render.mockResolvedValue(localRenderSet());
    const context = ctx();
    await reachApply(h, context);
    await h.run('deploy', 'build', context);

    await h.run('deploy', 'apply', context);

    expect(context.log).toHaveBeenCalledWith(
      'system',
      `seamnex/crm:1 was sha256:${'e'.repeat(64)} at the last deployment and is ${IMAGE_DIGEST} now: the artefact changed although the definition did not. Recorded as the new baseline`,
    );
    expect(h.docker.composeUp).toHaveBeenCalled();
  });

  it('accepts a rebuild that produced the id the instance already records', async () => {
    const h = setup([
      ['FROM instance_service', [{ service_name: 'app', image_digest: IMAGE_DIGEST }]],
    ]);
    h.renderer.render.mockResolvedValue(localRenderSet());
    const context = ctx();
    await reachApply(h, context);
    await h.run('deploy', 'build', context);

    await h.run('deploy', 'apply', context);

    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      `seamnex/crm:1 matches the recorded build ${IMAGE_DIGEST}`,
    );
    expect(h.docker.composeUp).toHaveBeenCalled();
  });

  it('says the recorded image is absent, not merely different, when the tag is gone', async () => {
    const recorded = `sha256:${'f'.repeat(64)}`;
    const h = setup([['FROM instance_service', [{ service_name: 'app', image_digest: recorded }]]]);
    h.renderer.render.mockResolvedValue(localRenderSet());
    // No build stage ran, so the only identity is the one recorded; the tag itself is gone.
    h.docker.imageId.mockResolvedValue(null);
    const context = ctx();
    await reachApply(h, context);

    await expect(h.run('deploy', 'apply', context)).rejects.toMatchObject({
      code: 'IMAGE_DIGEST_MISMATCH',
      detail: expect.stringContaining('is not present on this host'),
    });
    expect(h.docker.composeUp).not.toHaveBeenCalled();
  });

  it('says what the tag resolves to when the recorded image was replaced', async () => {
    const recorded = `sha256:${'f'.repeat(64)}`;
    const other = `sha256:${'1'.repeat(64)}`;
    const h = setup([['FROM instance_service', [{ service_name: 'app', image_digest: recorded }]]]);
    h.renderer.render.mockResolvedValue(localRenderSet());
    h.docker.imageId.mockResolvedValue(other);
    const context = ctx();
    await reachApply(h, context);

    await expect(h.run('deploy', 'apply', context)).rejects.toMatchObject({
      code: 'IMAGE_DIGEST_MISMATCH',
      detail: expect.stringContaining(`resolves to ${other}`),
    });
  });

  it('fails the post-up proof when the tag disappeared under the containers', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(localRenderSet());
    const context = ctx();
    await reachApply(h, context);
    await h.run('deploy', 'build', context);
    // The build already consumed its own read; the next two are the pre-up pin and the post-up proof.
    h.docker.imageId.mockResolvedValueOnce(IMAGE_DIGEST).mockResolvedValueOnce(null);

    await expect(h.run('deploy', 'apply', context)).rejects.toMatchObject({
      code: 'IMAGE_DIGEST_MISMATCH',
      detail: expect.stringContaining('resolves to nothing after the containers started'),
    });
    expect(h.docker.composeUp).toHaveBeenCalled();
  });
});

describe('render route evidence', () => {
  it('prefers the TLS mode the route row carries over the deploy-time snapshot', async () => {
    const { renderer, run } = setup([
      [
        'SELECT i.id, i.entry_key, i.slug, i.domain_route',
        [
          {
            ...INSTANCE_ROW,
            route_tls_mode: 'internal',
            payload: { route: { tlsMode: 'acme' } },
          },
        ],
      ],
    ]);
    const context = ctx();

    await run('deploy', 'resolve', context);
    await run('deploy', 'render', context);

    expect(renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ route: expect.objectContaining({ tlsMode: 'internal' }) }),
    );
  });

  it('takes the TLS mode from the deploy-time snapshot when the route row carries none', async () => {
    const { renderer, run } = setup([
      [
        'SELECT i.id, i.entry_key, i.slug, i.domain_route',
        [{ ...INSTANCE_ROW, payload: { route: { tlsMode: 'internal' } } }],
      ],
    ]);
    const context = ctx();

    await run('deploy', 'resolve', context);
    await run('deploy', 'render', context);

    expect(renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ route: expect.objectContaining({ tlsMode: 'internal' }) }),
    );
  });
});

describe('recorded versions', () => {
  it('names the version the operator confirmed in the success audit row', async () => {
    const h = setup();
    const context = ctx({ payload: { targetVersion: '9.2.1' } });
    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);
    await h.run('deploy', 'plan', context);

    await h.run('deploy', 'record', context);

    expect(h.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.deploy.succeeded',
        detail: expect.objectContaining({ targetVersion: '9.2.1', appliedVersion: '7.4' }),
      }),
    );
  });

  it('names the target a failed upgrade was trying to apply', async () => {
    const h = setup();

    await h.registry.failureHandler('upgrade')!(
      ctx({ action: 'upgrade', payload: { targetVersion: '9.2.1' } }),
      new Error('compose up failed'),
    );

    expect(h.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.upgrade.failed',
        detail: { jobId: 'job-1', fromState: 'verifying', targetVersion: '9.2.1' },
      }),
    );
  });
});

/**
 * The declared builds of a vendored tree, read straight from the mirror.
 *
 * `prepull` has no instance and no resolved source, so the only thing that can decide between a
 * build and a pull is the tree itself — and a tree it cannot read must fall back to the pull rather
 * than fail a prefetch that never promised to build anything.
 */
describe('prepull from a vendored tree', () => {
  function mirrorFor(entryKey: string, compose: string | null): string {
    const mirror = resolve(DATA_DIR, `mirror-${entryKey}`);
    const tree = join(mirror, entryKey);
    rmSync(mirror, { recursive: true, force: true });
    mkdirSync(tree, { recursive: true });
    if (compose !== null) writeFileSync(join(tree, 'docker-compose.yml'), compose);
    return mirror;
  }

  function treeOf(mirror: string, entryKey: string): string {
    return join(mirror, entryKey);
  }

  const CATALOG = 'SELECT payload FROM catalog_entry';

  it('falls back to the pull when the tree holds no compose file', async () => {
    const mirror = mirrorFor('D08-01', null);
    try {
      const h = setup([[CATALOG, [{ payload: { imageRef: 'repo/none:1' } }]]], {
        SEAMNEX_SOURCE_MIRROR_DIR: mirror,
      });

      await h.run(
        'prepull',
        'resolve',
        ctx({ action: 'prepull', payload: { entryKey: 'D08-01' } }),
      );

      expect(h.docker.build).not.toHaveBeenCalled();
      expect(h.docker.pull).toHaveBeenCalledWith(
        'repo/none:1',
        expect.any(Function),
        expect.anything(),
      );
    } finally {
      rmSync(join(mirror, 'D08-01'), { recursive: true, force: true });
    }
  });

  it('falls back to the pull when the document declares no service map', async () => {
    const mirror = mirrorFor('D08-02', 'services: 3\n');
    try {
      const h = setup([[CATALOG, [{ payload: { imageRef: 'repo/map:1' } }]]], {
        SEAMNEX_SOURCE_MIRROR_DIR: mirror,
      });

      await h.run(
        'prepull',
        'resolve',
        ctx({ action: 'prepull', payload: { entryKey: 'D08-02' } }),
      );

      expect(h.docker.build).not.toHaveBeenCalled();
      expect(h.docker.pull).toHaveBeenCalledWith(
        'repo/map:1',
        expect.any(Function),
        expect.anything(),
      );
    } finally {
      rmSync(join(mirror, 'D08-02'), { recursive: true, force: true });
    }
  });

  it('ignores a service that declares no build', async () => {
    const mirror = mirrorFor('D08-03', 'services:\n  db:\n    image: mariadb:11\n');
    try {
      const h = setup([[CATALOG, [{ payload: { imageRef: 'repo/db:11' } }]]], {
        SEAMNEX_SOURCE_MIRROR_DIR: mirror,
      });

      await h.run(
        'prepull',
        'resolve',
        ctx({ action: 'prepull', payload: { entryKey: 'D08-03' } }),
      );

      expect(h.docker.build).not.toHaveBeenCalled();
      expect(h.docker.pull).toHaveBeenCalledWith(
        'repo/db:11',
        expect.any(Function),
        expect.anything(),
      );
    } finally {
      rmSync(join(mirror, 'D08-03'), { recursive: true, force: true });
    }
  });

  it('refuses a declared build that cannot name the artefact it produces', async () => {
    const mirror = mirrorFor('D08-04', 'services:\n  app:\n    build: .\n');
    try {
      const h = setup([], { SEAMNEX_SOURCE_MIRROR_DIR: mirror });

      await expect(
        h.run('prepull', 'resolve', ctx({ action: 'prepull', payload: { entryKey: 'D08-04' } })),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        detail: expect.stringContaining('declares build: without image:'),
      });
      expect(h.docker.build).not.toHaveBeenCalled();
      expect(h.docker.pull).not.toHaveBeenCalled();
    } finally {
      rmSync(join(mirror, 'D08-04'), { recursive: true, force: true });
    }
  });

  it('reads a build declared as a plain context string and defaults the Dockerfile name', async () => {
    const mirror = mirrorFor(
      'D08-05',
      'services:\n  app:\n    image: seamnex/str:1\n    build: .\n',
    );
    try {
      const h = setup([], { SEAMNEX_SOURCE_MIRROR_DIR: mirror });
      const tree = treeOf(mirror, 'D08-05');

      await h.run(
        'prepull',
        'resolve',
        ctx({ action: 'prepull', payload: { entryKey: 'D08-05' } }),
      );

      expect(h.docker.build).toHaveBeenCalledWith({
        context: tree,
        dockerfile: join(tree, 'Dockerfile'),
        tag: 'seamnex/str:1',
      });
    } finally {
      rmSync(join(mirror, 'D08-05'), { recursive: true, force: true });
    }
  });

  it('defaults the build context to the tree root when the block names none', async () => {
    const mirror = mirrorFor(
      'D08-06',
      'services:\n  app:\n    image: seamnex/ctx:1\n    build:\n      dockerfile: Custom.Dockerfile\n',
    );
    try {
      const h = setup([], { SEAMNEX_SOURCE_MIRROR_DIR: mirror });
      const tree = treeOf(mirror, 'D08-06');

      await h.run(
        'prepull',
        'resolve',
        ctx({ action: 'prepull', payload: { entryKey: 'D08-06' } }),
      );

      expect(h.docker.build).toHaveBeenCalledWith({
        context: tree,
        dockerfile: join(tree, 'Custom.Dockerfile'),
        tag: 'seamnex/ctx:1',
      });
    } finally {
      rmSync(join(mirror, 'D08-06'), { recursive: true, force: true });
    }
  });

  it('reports a build the daemon cannot name instead of claiming it is local', async () => {
    const mirror = mirrorFor(
      'D08-07',
      'services:\n  app:\n    image: seamnex/anonymous:1\n    build: .\n',
    );
    try {
      const h = setup([], { SEAMNEX_SOURCE_MIRROR_DIR: mirror });
      h.docker.imageId.mockResolvedValue(null);

      await h.run(
        'prepull',
        'resolve',
        ctx({ action: 'prepull', payload: { entryKey: 'D08-07' } }),
      );

      expect(h.docker.pull).not.toHaveBeenCalled();
      expect(await h.docker.imageId('seamnex/anonymous:1')).toBeNull();
      expect(h.docker.build).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'seamnex/anonymous:1' }),
      );
    } finally {
      rmSync(join(mirror, 'D08-07'), { recursive: true, force: true });
    }
  });
});

describe('recordVolumes tolerances', () => {
  async function reachApply(h: ReturnType<typeof setup>, context: PipelineContext): Promise<void> {
    await h.run('deploy', 'resolve', context);
    await h.run('deploy', 'render', context);
  }

  it('names a volume whose mount path the render set does not carry, and registers nothing', async () => {
    const h = setup([["SELECT payload -> 'volumes'", [{ volumes: [] }]]]);
    // No compose volume label: the key is the daemon's own name, which the document cannot mount.
    h.docker.volumes.mockResolvedValue([
      {
        name: 'seamnex-crm_orphan',
        mountpoint: '/var/lib/docker/volumes/seamnex-crm_orphan/_data',
        labels: {},
      },
    ]);
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(context.log).toHaveBeenCalledWith(
      'system',
      'volume seamnex-crm_orphan has no mount path in the render set; it is not registered and a backup will refuse while the definition still declares it',
    );
    expect(h.db.calls.some((call) => call.sql.includes('INSERT INTO instance_volume'))).toBe(false);
    expect(context.log).toHaveBeenCalledWith(
      'stdout',
      '0 data volume(s) registered for backup and quota checks (the definition declares none)',
    );
  });

  it('ignores catalog volume entries it cannot read, and rounds the quota it can', async () => {
    const h = setup([
      [
        "SELECT payload -> 'volumes'",
        [
          {
            volumes: [
              null,
              'plain-string',
              { name: '', quotaMb: 1_000 },
              { name: 'no-quota' },
              { name: 'zero', quotaMb: 0 },
              { name: 'textual', quotaMb: '8192' },
              { name: 'db', mountPath: '/var/lib/db', quotaMb: 4_096.4 },
            ],
          },
        ],
      ],
    ]);
    h.docker.volumes.mockResolvedValue([
      {
        name: 'seamnex-crm_db',
        mountpoint: '',
        labels: { 'com.docker.compose.volume': 'db' },
      },
    ]);
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    const insert = h.db.calls.find((call) => call.sql.includes('INSERT INTO instance_volume'));
    // A declaration without a usable quota is skipped, so the readable one still sets the quota.
    expect(insert?.params).toEqual([INSTANCE_ID, 'seamnex-crm_db', '/var/lib/db', null, 4_096]);
  });

  it('names a declared volume whose path neither the catalog nor the definition carries', async () => {
    // The catalog describes the volume's quota but not its mount path, and the render set holds no
    // platform document to read one from: the volume is named, not registered against a guess.
    const h = setup([
      ["SELECT payload -> 'volumes'", [{ volumes: [{ name: 'db', quotaMb: 512 }] }]],
    ]);
    h.renderer.render.mockResolvedValue(
      renderSetOf({ files: [{ path: 'other.yml', sha256: 'd'.repeat(64), content: 'x: 1' }] }),
    );
    h.docker.volumes.mockResolvedValue([
      {
        name: 'seamnex-crm_db',
        mountpoint: '',
        labels: { 'com.docker.compose.volume': 'db' },
      },
    ]);
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(context.log).toHaveBeenCalledWith(
      'system',
      'volume seamnex-crm_db has no mount path in the render set; it is not registered and a backup will refuse while the definition still declares it',
    );
    expect(h.db.calls.some((call) => call.sql.includes('INSERT INTO instance_volume'))).toBe(false);
  });

  it('reports a daemon that failed without an Error object', async () => {
    const h = setup();
    h.docker.volumes.mockRejectedValue('daemon gone');
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(context.log).toHaveBeenCalledWith(
      'system',
      expect.stringContaining('could not be listed (daemon gone)'),
    );
    expect(h.docker.composeUp).toHaveBeenCalled();
  });
});
