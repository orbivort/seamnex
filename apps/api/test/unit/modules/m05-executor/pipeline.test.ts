import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
    imageDigest: 'sha256:abc',
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
    imageIdentity: vi.fn(async () => ({ ref: 'repo/crm:7.4', digest: 'sha256:abc', id: 'abc' })),
    networkEndpoints: vi.fn(async () => [] as unknown[]),
    disconnectNetwork: vi.fn(async () => undefined),
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
    registerIdentity: vi.fn(async () => ({
      clientId: 'seamnex-crm',
      adapter: { adapter: 'oidc', syncState: 'applied' },
    })),
    runChecks: vi.fn(async (_instanceId: string): Promise<CheckVerdict> => ({
      checks: [],
      ready: true,
      blocking: [],
    })),
  };
  const outbox = { emit: vi.fn(async () => undefined) };
  const config = {
    SEAMNEX_ADAPTERS_MODE: 'real',
    SEAMNEX_DOCKER_HOST: 'unix:///var/run/docker.sock',
    SEAMNEX_VERIFY_TIMEOUT_MS: 30_000,
    SEAMNEX_VERIFY_MAX_RESTARTS: 3,
    SEAMNEX_VERIFY_UNHEALTHY_GRACE_MS: 0,
    SEAMNEX_INSTANCE_DATA_DIR: DATA_DIR,
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
      'apply',
      'verify',
      'integrate',
      'record',
    ]);
    // A reconfigure is a deploy: same stages, so there is one definition of "apply this".
    expect(registry.stepsFor('reconfigure')).toEqual(registry.stepsFor('deploy'));
    expect(registry.stages('upgrade')?.map((stage) => stage.name)).toContain('backup');
    expect(registry.stepsFor('upgrade')).toHaveLength(8);
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
    // An export records a run with an instance but no render set of its own.
    const h = setup();
    const context = ctx({ action: 'export' });
    await h.run('export', 'apply', context);

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
    const context = ctx({ action: 'export' });
    await h.run('export', 'apply', context);

    await expect(h.run('deploy', 'apply', context)).rejects.toThrow('apply ran before render');
    expect(h.docker.composeUp).not.toHaveBeenCalled();
  });

  it('builds the image a Dockerfile source declares', async () => {
    const h = setup();
    h.sources.resolve.mockResolvedValue(
      sourceOf({
        path: 'dockerfile',
        dockerfilePath: '/work/crm/Dockerfile',
        imageRef: 'repo/crm:dev',
      }) as never,
    );
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(context.log).toHaveBeenCalledWith('stdout', 'building repo/crm:dev');
    expect(h.docker.build).toHaveBeenCalledWith({
      context: '/work/crm',
      dockerfile: '/work/crm/Dockerfile',
      tag: 'repo/crm:dev',
      labels: { 'seamnex.instance': INSTANCE_ID, 'seamnex.entry': 'D01-01' },
    });
  });

  it('falls back to the conventional Dockerfile name for a scaffold, and skips the build without a tag', async () => {
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
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(h.docker.build).toHaveBeenCalledWith(
      expect.objectContaining({ dockerfile: join('/work/scaffold', 'Dockerfile') }),
    );
  });

  it('skips the build entirely when the source declares no image reference', async () => {
    const h = setup();
    h.sources.resolve.mockResolvedValue(
      sourceOf({
        path: 'dockerfile',
        dockerfilePath: '/work/crm/Dockerfile',
        imageRef: null,
      }) as never,
    );
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(h.docker.build).not.toHaveBeenCalled();
  });

  it('rebuilds every service whose definition carries a build section', async () => {
    const h = setup();
    h.renderer.render.mockResolvedValue(
      renderSetOf({
        files: [
          {
            path: COMPOSE,
            sha256: 'c'.repeat(64),
            content: 'services:\n  app:\n    build: .\n  db:\n    image: mariadb:11\n',
          },
        ],
      }),
    );
    const context = ctx();
    await reachApply(h, context);

    await h.run('deploy', 'apply', context);

    expect(context.log).toHaveBeenCalledWith('stdout', 'building from the definition: app');
    expect(h.docker.composeBuild).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'seamnex-crm' }),
      expect.any(Function),
    );
    expect(context.log).toHaveBeenCalledWith('stdout', 'build output');
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
    expect(payloadUpdate?.params).toEqual([INSTANCE_ID, 'rs-000000000001', 'compose']);
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
        detail: {
          jobId: 'job-1',
          renderSetId: 'rs-000000000001',
          planId: 'plan-000000000001',
          changes: 1,
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
    expect(payloadUpdate?.params).toEqual([INSTANCE_ID, 'rs-previous-1234', 'compose']);
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
        detail: { jobId: 'job-1', fromState: 'verifying' },
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

describe('export', () => {
  it('writes the render set identity of the applied deployment', async () => {
    const h = setup();
    const context = ctx({ action: 'export' });

    await h.run('export', 'apply', context);

    const line = (
      context.log as unknown as { mock: { calls: [string, string][] } }
    ).mock.calls.find((call) => call[1].startsWith('export written to '));
    expect(line?.[1]).toBeDefined();
    const file = String(line?.[1]).replace('export written to ', '');
    const document = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(document).toMatchObject({
      instance: { id: INSTANCE_ID, slug: 'crm', entryKey: 'D01-01', state: 'deploying' },
      renderSet: { id: 'rs-000000000001', contentHash: 'hash-1' },
    });
  });

  it('records an export of an instance that has never been rendered', async () => {
    const h = setup();
    h.renderer.applied.mockResolvedValue(null);
    const context = ctx({ action: 'export' });

    await h.run('export', 'apply', context);

    const line = (
      context.log as unknown as { mock: { calls: [string, string][] } }
    ).mock.calls.find((call) => call[1].startsWith('export written to '));
    const document = JSON.parse(
      readFileSync(String(line?.[1]).replace('export written to ', ''), 'utf8'),
    ) as {
      renderSet: unknown;
    };
    expect(document.renderSet).toBeNull();
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
    expect(h.docker.pull).toHaveBeenCalledWith('repo/crm:7.4', expect.any(Function));
  });

  it('pulls nothing for an entry that declares no image, or for a job with no entry at all', async () => {
    const h = setup([['SELECT payload FROM catalog_entry', [{ payload: {} }]]]);

    await h.run('prepull', 'resolve', ctx({ action: 'prepull', payload: { entryKey: 'D01-01' } }));
    expect(h.docker.pull).not.toHaveBeenCalled();

    await h.run('prepull', 'resolve', ctx({ action: 'prepull', jobId: 'job-2' }));
    // No `entryKey` in the payload resolves to the empty key, which the catalog has no row for.
    expect(
      h.db.calls.filter((call) => call.sql.includes('FROM catalog_entry')).pop()?.params,
    ).toEqual(['']);
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
