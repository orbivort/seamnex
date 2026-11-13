import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeDb, type Route } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import {
  PostgresStatusHealthService,
  derive,
} from '../../../../src/modules/m06-status-health/status-health.service';

/**
 * The sampler owns the only write path into `instance_status`, `container_status` and
 * `probe_result`, and each branch in it stands for a failure that was seen in a running stack:
 * an empty container list is ambiguous (a failed Docker listing looks exactly like an instance with
 * nothing running), a probe that could not answer must not be read as success, a recreated
 * container leaves a ghost row unless the sample prunes what it did not see, and a transitional
 * instance belongs to a job — overwriting its state would make a deploy look finished early.
 */
const CRM = '11111111-1111-4111-8111-111111111111';
const SHOP = '22222222-2222-4222-8222-222222222222';
const CONTAINER = 'c0ffee';

type FakeMock = ReturnType<typeof vi.fn>;

function config(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    SEAMNEX_SAMPLE_CONCURRENCY: 4,
    SEAMNEX_SAMPLE_TIMEOUT_MS: 1_000,
    ...overrides,
  } as unknown as AppConfig;
}

function dockerFake(overrides: Record<string, unknown> = {}): {
  containers: FakeMock;
  inspect: FakeMock;
  logs: FakeMock;
  runCli: FakeMock;
} {
  return Object.assign(
    {
      containers: vi.fn(async (): Promise<unknown[]> => []),
      inspect: vi.fn(async (): Promise<unknown> => ({})),
      logs: vi.fn(async (): Promise<string> => ''),
      runCli: vi.fn(async () => ({ code: 0, stdout: 'HTTP 200\n', stderr: '', truncated: false })),
    },
    overrides,
  ) as unknown as { containers: FakeMock; inspect: FakeMock; logs: FakeMock; runCli: FakeMock };
}

function build(
  options: {
    routes?: Parameters<typeof fakeDb>[0];
    config?: Record<string, unknown>;
    docker?: Record<string, unknown>;
  } = {},
) {
  const db = fakeDb(options.routes ?? [], { allowUnmatched: false });
  const docker = dockerFake(options.docker ?? {});
  const service = new PostgresStatusHealthService(
    db.pool,
    config(options.config ?? {}),
    docker as never,
  );
  return { db, docker, service };
}

/** Every statement the sampler issues, addressable by a fragment unique to that statement. */
function statement(db: ReturnType<typeof fakeDb>, fragment: string) {
  return db.calls.find((entry) => entry.sql.includes(fragment));
}

function statusRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'ready',
    ready: true,
    observed_at: new Date('2024-05-01T00:00:00.000Z'),
    source: 'poll',
    reason: null,
    containers_total: 2,
    containers_running: 2,
    maintenance_title: null,
    maintenance_id: null,
    maintenance_start: null,
    maintenance_end: null,
    ...overrides,
  };
}

function instanceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: CRM, slug: 'crm', state: 'ready', payload: { httpPort: 8080 }, ...overrides };
}

function container(id: string, owner: string | null, state = 'running') {
  return {
    id,
    name: `${id}-1`,
    service: 'web',
    image: 'busybox:1.36',
    state,
    status: 'Up 1 minute',
    labels: owner === null ? {} : { 'seamnex.instance': owner },
  };
}

/** The statements a healthy sample issues, so a test only states the rows it cares about. */
function sampleRoutes(instances: Record<string, unknown>[]): readonly Route[] {
  return [
    ['WHERE deleted_at IS NULL AND', instances],
    ['DELETE FROM container_status', []],
    ['INSERT INTO container_status', []],
    ["VALUES ($1, 'http'", []],
    ["VALUES ($1, 'container'", []],
    ['INSERT INTO instance_status', []],
    ['UPDATE instance SET state', []],
  ];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the status read model', () => {
  it('refuses a path parameter that is not a UUID instead of raising a cast error', async () => {
    const { db, service } = build();

    await expect(service.status('not-a-uuid', false)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No instance not-a-uuid.',
    });
    // Nothing reached the database: a malformed id would have raised 22P02, a 500 for a 404.
    expect(db.calls).toHaveLength(0);
  });

  it('returns the recorded sample with its container counts and observation time', async () => {
    const { db, service } = build({
      routes: [
        ['FROM instance_status s', [statusRow()]],
        ['SELECT 1 FROM instance', []],
      ],
    });

    await expect(service.status(CRM, false)).resolves.toEqual({
      instanceId: CRM,
      state: 'ready',
      plainStatus: 'available',
      ready: true,
      reason: null,
      observedAt: '2024-05-01T00:00:00.000Z',
      source: 'poll',
      containersRunning: 2,
      containersTotal: 2,
      maintenance: null,
    });
    expect(db.calls[0]?.params).toEqual([CRM]);
  });

  it('samples first when the caller asks for a refresh', async () => {
    const { db, service } = build({
      routes: [
        ['FROM instance_status s', [statusRow()]],
        ['WHERE deleted_at IS NULL AND', () => Promise.reject(new Error('sampler unavailable'))],
      ],
    });

    await expect(service.status(CRM, true)).resolves.toMatchObject({ plainStatus: 'available' });
    expect(statement(db, 'WHERE deleted_at IS NULL AND')).toBeDefined();
  });

  it('does not sample when the caller does not ask for it', async () => {
    const { db, service } = build({ routes: [['FROM instance_status s', [statusRow()]]] });

    await service.status(CRM, false);

    expect(statement(db, 'WHERE deleted_at IS NULL AND')).toBeUndefined();
  });

  it('reports a missing instance when neither a sample nor an instance row exists', async () => {
    const { service } = build({
      routes: [
        ['FROM instance_status s', []],
        ['SELECT 1 FROM instance', []],
      ],
    });

    await expect(service.status(CRM, false)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No instance ${CRM}.`,
    });
  });

  it('names the sampler, not the instance, when the instance exists but has never been sampled', async () => {
    const { service } = build({
      routes: [
        ['FROM instance_status s', []],
        ['SELECT 1 FROM instance', [{ '?column?': 1 }]],
      ],
    });

    await expect(service.status(CRM, false)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No status sample has been recorded for this instance yet.',
    });
  });
});

type StatusCase = [
  name: string,
  overrides: Record<string, unknown>,
  plainStatus: string,
  maintenance: unknown,
];

const WINDOW = {
  maintenance_title: 'year-end close',
  maintenance_id: 'window-1',
  maintenance_start: new Date('2024-04-01T00:00:00.000Z'),
  maintenance_end: new Date('2024-06-01T00:00:00.000Z'),
};

/**
 * `plainStatus` is the one field the portal renders as a badge, and every one of its values is a
 * different sentence to an operator: a transitional state is progress, `degraded` is a fault,
 * `unavailable` is a stop, and a maintenance window outranks all of them.
 */
const STATUS_CASES: StatusCase[] = [
  ['a ready instance', {}, 'available', null],
  ['a transitional instance', { state: 'deploying', ready: false }, 'unavailable', null],
  ['a degraded instance', { state: 'degraded', ready: false }, 'degraded', null],
  ['a failed instance', { state: 'failed', ready: false }, 'unavailable', null],
  [
    'an instance inside a maintenance window',
    { ...WINDOW },
    'maintenance',
    {
      active: true,
      windowId: 'window-1',
      title: 'year-end close',
      startsAt: '2024-04-01T00:00:00.000Z',
      endsAt: '2024-06-01T00:00:00.000Z',
    },
  ],
  [
    'a window that has not been titled yet',
    { ...WINDOW, maintenance_title: null },
    'available',
    null,
  ],
  ['a window with no start recorded', { ...WINDOW, maintenance_start: null }, 'available', null],
  ['a window with no end recorded', { ...WINDOW, maintenance_end: null }, 'available', null],
];

describe('the rendered plain status', () => {
  it.each(STATUS_CASES)('describes %s', async (_name, overrides, plainStatus, maintenance) => {
    const { service } = build({ routes: [['FROM instance_status s', [statusRow(overrides)]]] });

    const result = await service.status(CRM, false);

    expect(result.plainStatus).toBe(plainStatus);
    expect(result.maintenance).toEqual(maintenance);
  });
});

describe('the container list', () => {
  it('refuses a path parameter that is not a UUID', async () => {
    const { service } = build();

    await expect(service.containers('not-a-uuid')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps rows, defaulting the role, the start time and the digest the daemon never reported', async () => {
    const { db, service } = build({
      routes: [
        [
          'FROM container_status c',
          [
            {
              container_id: 'abc',
              service: 'web',
              role: 'worker',
              state: 'running',
              health: 'healthy',
              restart_count: 1,
              started_at: new Date('2024-05-01T00:00:00.000Z'),
              exit_code: 0,
              exit_reason: null,
              image_digest: 'sha256:deadbeef',
              observed_at: new Date('2024-05-01T00:00:05.000Z'),
            },
            {
              container_id: 'def',
              service: 'db',
              role: null,
              state: 'exited',
              health: 'none',
              restart_count: 0,
              started_at: null,
              exit_code: 1,
              exit_reason: 'OOMKilled',
              image_digest: null,
              observed_at: new Date('2024-05-01T00:00:05.000Z'),
            },
          ],
        ],
      ],
    });

    await expect(service.containers(CRM)).resolves.toEqual([
      {
        containerId: 'abc',
        service: 'web',
        role: 'worker',
        state: 'running',
        health: 'healthy',
        restartCount: 1,
        startedAt: '2024-05-01T00:00:00.000Z',
        exitCode: 0,
        exitReason: null,
        imageDigest: 'sha256:deadbeef',
        observedAt: '2024-05-01T00:00:05.000Z',
      },
      {
        containerId: 'def',
        service: 'db',
        role: 'primary',
        state: 'exited',
        health: 'none',
        restartCount: 0,
        startedAt: null,
        exitCode: 1,
        exitReason: 'OOMKilled',
        imageDigest: 'sha256:unknown',
        observedAt: '2024-05-01T00:00:05.000Z',
      },
    ]);
    expect(db.calls[0]?.params).toEqual([CRM]);
  });

  it('returns an empty list for an instance with no recorded containers', async () => {
    const { service } = build({ routes: [['FROM container_status c', []]] });

    await expect(service.containers(CRM)).resolves.toEqual([]);
  });
});

describe('container logs', () => {
  it('refuses a path parameter that is not a UUID', async () => {
    const { service } = build();

    await expect(service.containerLogs('not-a-uuid', CONTAINER, 10)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a container that does not belong to the instance', async () => {
    const { db, service } = build({ routes: [['SELECT container_id FROM container_status', []]] });

    await expect(service.containerLogs(CRM, CONTAINER, 10)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `Container ${CONTAINER} does not belong to instance ${CRM}.`,
    });
    expect(db.calls[0]?.params).toEqual([CRM, CONTAINER]);
  });

  it('numbers the lines, spaces them one second apart and masks credentials in place', async () => {
    const { docker, service } = build({
      routes: [['SELECT container_id FROM container_status', [{ container_id: CONTAINER }]]],
      docker: {
        logs: vi.fn(async () => 'starting up\r\napi_token=super-secret\r\n\r\ndone'),
      },
    });

    const lines = await service.containerLogs(CRM, CONTAINER, 200);

    // The blank line is not a log line; the position of the rest stands in for a timestamp the
    // endpoint does not carry.
    expect(lines.map((line) => line.seq)).toEqual([1, 2, 3]);
    expect(lines.map((line) => line.line)).toEqual(['starting up', 'api_token=********', 'done']);
    expect(lines.every((line) => line.stream === 'stdout')).toBe(true);
    const stamps = lines.map((line) => Date.parse(line.ts));
    expect(stamps[1]).toBeGreaterThan(stamps[0] ?? Number.NaN);
    expect(stamps[2]).toBeGreaterThan(stamps[1] ?? Number.NaN);
    expect(docker.logs).toHaveBeenCalledWith(CONTAINER, 200);
  });

  it.each([
    ['a tail of zero', 0, 1],
    ['an oversized tail', 5_000, 1_000],
  ])('clamps %s to what the daemon accepts', async (_name, requested, sent) => {
    const { docker, service } = build({
      routes: [['SELECT container_id FROM container_status', [{ container_id: CONTAINER }]]],
    });

    await service.containerLogs(CRM, CONTAINER, requested);

    expect(docker.logs).toHaveBeenCalledWith(CONTAINER, sent);
  });
});

describe('one sampling cycle', () => {
  it('lists the fleet in one Docker call and counts ready and degraded instances apart', async () => {
    const { db, docker, service } = build({
      routes: sampleRoutes([instanceRow(), instanceRow({ id: SHOP, slug: 'shop', payload: {} })]),
      docker: {
        containers: vi.fn(async () => [
          container('crm-1', CRM),
          container('shop-1', SHOP, 'exited'),
        ]),
      },
    });

    await expect(service.sample()).resolves.toEqual({ instances: 2, ready: 1, degraded: 1 });

    // One call for the whole fleet: N container lists would be N round trips before the first probe.
    expect(docker.containers).toHaveBeenCalledOnce();
    expect(docker.containers.mock.calls[0]).toEqual([['seamnex.instance'], true]);
    // Each instance prunes to exactly the containers the daemon reported for it.
    const pruned = db.calls
      .filter((entry) => entry.sql.includes('DELETE FROM container_status'))
      .map((entry) => entry.params)
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    expect(pruned).toEqual([
      [CRM, ['crm-1']],
      [SHOP, ['shop-1']],
    ]);

    // The probe is the fleet-wide question, and the answer is recorded as evidence, not just used.
    const http = statement(db, "VALUES ($1, 'http'");
    expect(http?.params[1]).toBe(true);
    expect(JSON.parse(String(http?.params[3]))).toEqual({
      target: 'http://crm:8080/',
      method: 'ephemeral-container',
      answer: 'HTTP 200',
    });
    // The probe container gets its own budget, one second beyond the sampler's, so the sampler
    // records "timed out" rather than killing the probe under it.
    expect(docker.runCli.mock.calls[0]?.[2]).toBe(2_000);
  });

  it('derives degraded, and skips the probe, when one container of the instance is down', async () => {
    const { db, docker, service } = build({
      routes: sampleRoutes([instanceRow()]),
      docker: {
        containers: vi.fn(async () => [container('crm-1', CRM), container('crm-2', CRM, 'exited')]),
      },
    });

    await expect(service.sample()).resolves.toEqual({ instances: 1, ready: 0, degraded: 1 });

    // Both containers share one instance list, and no probe is attempted for a half-down product.
    expect(docker.runCli).not.toHaveBeenCalled();
    expect(statement(db, "VALUES ($1, 'http'")).toBeUndefined();
    expect(statement(db, 'INSERT INTO instance_status')?.params).toEqual([
      CRM,
      'degraded',
      false,
      '1 of 2 container(s) not running',
    ]);
  });

  it('counts neither ready nor degraded when there is nothing to observe', async () => {
    const { db, service } = build({
      routes: sampleRoutes([
        instanceRow(),
        instanceRow({ id: SHOP, slug: 'shop', state: 'stopped', payload: {} }),
      ]),
    });

    await expect(service.sample()).resolves.toEqual({ instances: 2, ready: 0, degraded: 0 });

    // Nothing was observed, so nothing is pruned: an empty list is also what a failed listing is.
    expect(statement(db, 'DELETE FROM container_status')).toBeUndefined();
    const states = db.calls
      .filter((entry) => entry.sql.includes('INSERT INTO instance_status'))
      .map((entry) => entry.params[1]);
    expect(states).toEqual(['failed', 'stopped']);
  });

  it('keeps sampling when the container list cannot be read at all', async () => {
    const { db, service } = build({
      routes: sampleRoutes([instanceRow()]),
      docker: { containers: vi.fn(async () => Promise.reject(new Error('daemon gone'))) },
    });

    await expect(service.sample()).resolves.toEqual({ instances: 1, ready: 0, degraded: 0 });

    expect(statement(db, 'INSERT INTO instance_status')?.params).toEqual([
      CRM,
      'failed',
      false,
      'no containers',
    ]);
  });

  it('ignores containers that carry no instance label', async () => {
    const { db, service } = build({
      routes: sampleRoutes([instanceRow()]),
      docker: { containers: vi.fn(async () => [container('orphan-1', null)]) },
    });

    await expect(service.sample()).resolves.toEqual({ instances: 1, ready: 0, degraded: 0 });

    expect(statement(db, 'INSERT INTO instance_status')?.params[1]).toBe('failed');
  });

  it('limits the cycle to one instance when the manual refresh names it', async () => {
    const { db, service } = build({ routes: sampleRoutes([instanceRow()]) });

    await service.sample(CRM);
    await service.sample();

    const listings = db.calls.filter((entry) => entry.sql.includes('WHERE deleted_at IS NULL AND'));
    expect(listings.map((entry) => entry.params[0])).toEqual([CRM, null]);
  });

  it('walks past an instance state a job owns instead of overwriting it', async () => {
    const { db, service } = build({
      routes: sampleRoutes([instanceRow({ state: 'deploying' })]),
      docker: { containers: vi.fn(async () => [container('crm-1', CRM)]) },
    });

    await service.sample();

    expect(statement(db, 'INSERT INTO instance_status')?.params[1]).toBe('deploying');
    // The deploy job owns `instance.state`; writing it mid-transition would report a finished deploy.
    expect(statement(db, 'UPDATE instance SET state')).toBeUndefined();
  });

  it('advances the instance state when no job owns it', async () => {
    const { db, service } = build({
      routes: sampleRoutes([instanceRow()]),
      docker: { containers: vi.fn(async () => [container('crm-1', CRM)]) },
    });

    await service.sample();

    expect(statement(db, 'UPDATE instance SET state')?.params).toEqual([CRM, 'ready']);
  });
});

describe('the HTTP readiness probe', () => {
  it('records a probe that never answered instead of waiting for the container', async () => {
    vi.useFakeTimers();
    const { db, service } = build({
      routes: sampleRoutes([instanceRow()]),
      docker: {
        containers: vi.fn(async () => [container('crm-1', CRM)]),
        // The probe container is still running when the sampler's own budget expires.
        runCli: vi.fn(() => new Promise<never>(() => undefined)),
      },
    });

    const pending = service.sample();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ instances: 1, ready: 0, degraded: 1 });

    const http = statement(db, "VALUES ($1, 'http'");
    expect(http?.params[1]).toBe(false);
    // "302 Found" and "no HTTP answer" are different facts, and neither used to be recorded.
    expect(JSON.parse(String(http?.params[3]))).toEqual({
      target: 'http://crm:8080/',
      method: 'ephemeral-container',
      answer: 'timed out',
    });
    expect(statement(db, 'INSERT INTO instance_status')?.params[3]).toBe(
      'HTTP readiness probe failed',
    );
  });

  it('treats a probe row that cannot be written as a failed probe', async () => {
    // `sampleRoutes` is now a concrete list; the callback states `Route` so the patched tuple keeps
    // its exact shape instead of widening to an array of mixed elements.
    const routes: readonly Route[] = sampleRoutes([instanceRow()]).map(
      ([matcher, result]): Route =>
        matcher === "VALUES ($1, 'http'"
          ? [matcher, () => Promise.reject(new Error('write failed'))]
          : [matcher, result],
    );
    const { db, service } = build({
      routes,
      docker: { containers: vi.fn(async () => [container('crm-1', CRM)]) },
    });

    await expect(service.sample()).resolves.toEqual({ instances: 1, ready: 0, degraded: 1 });

    expect(statement(db, 'INSERT INTO instance_status')?.params[1]).toBe('degraded');
  });

  it('records a product that answers in a broken state as not ready', async () => {
    const { db, service } = build({
      routes: sampleRoutes([instanceRow({ payload: {} })]),
      docker: {
        containers: vi.fn(async () => [container('crm-1', CRM)]),
        runCli: vi.fn(async () => ({
          code: 1,
          stdout: '',
          stderr: 'no HTTP answer',
          truncated: false,
        })),
      },
    });

    await expect(service.sample()).resolves.toEqual({ instances: 1, ready: 0, degraded: 1 });

    // No declared port means the product is on 80.
    const http = statement(db, "VALUES ($1, 'http'");
    expect(JSON.parse(String(http?.params[3]))).toMatchObject({ target: 'http://crm:80/' });
    expect(statement(db, 'INSERT INTO instance_status')?.params[3]).toBe(
      'HTTP readiness probe failed',
    );
  });
});

describe('the container projection', () => {
  it.each([
    ['a healthy container', 'healthy', 'healthy'],
    ['an unhealthy container', 'unhealthy', 'unhealthy'],
    ['a container still starting', 'starting', 'starting'],
    ['a health status the platform does not model', 'weird', 'none'],
    ['a container with no healthcheck at all', undefined, 'none'],
  ])('projects %s', async (_name, reported, health) => {
    const { db, service } = build({
      routes: sampleRoutes([instanceRow()]),
      docker: {
        containers: vi.fn(async () => [container('crm-1', CRM)]),
        inspect: vi.fn(async () => ({
          State: { Status: 'running', Health: { Status: reported } },
        })),
      },
    });

    await service.sample();

    expect(statement(db, 'INSERT INTO container_status')?.params[4]).toBe(health);
  });

  it('takes the state, restarts, exit and image from the daemon when it can be inspected', async () => {
    const { db, service } = build({
      routes: sampleRoutes([instanceRow()]),
      docker: {
        containers: vi.fn(async () => [container('crm-1', CRM)]),
        inspect: vi.fn(async () => ({
          State: {
            Status: 'running',
            StartedAt: '2024-05-01T00:00:00.000Z',
            ExitCode: 0,
            Error: '',
            Health: { Status: 'healthy' },
          },
          RestartCount: 2,
          Image: 'sha256:deadbeef',
        })),
      },
    });

    await service.sample();

    expect(statement(db, 'INSERT INTO container_status')?.params).toEqual([
      CRM,
      'crm-1',
      'web',
      'running',
      'healthy',
      2,
      '2024-05-01T00:00:00.000Z',
      0,
      '',
      'sha256:deadbeef',
    ]);
    // A container that is not running is recorded as a failed probe, not as a missing row.
    expect(statement(db, "VALUES ($1, 'container'")?.params[1]).toBe(true);
  });

  it('falls back to the listing when the container cannot be inspected', async () => {
    const { db, service } = build({
      routes: sampleRoutes([instanceRow()]),
      docker: {
        containers: vi.fn(async () => [container('crm-1', CRM, 'exited')]),
        inspect: vi.fn(async () => Promise.reject(new Error('no such container'))),
      },
    });

    await service.sample();

    expect(statement(db, 'INSERT INTO container_status')?.params).toEqual([
      CRM,
      'crm-1',
      'web',
      'exited',
      'none',
      0,
      null,
      null,
      null,
      null,
    ]);
    expect(statement(db, "VALUES ($1, 'container'")?.params[1]).toBe(false);
  });
});

describe('status derivation', () => {
  type DeriveCase = [
    name: string,
    previous: string,
    containers: { state: string }[],
    httpReady: boolean | null,
    expected: Record<string, unknown>,
  ];

  const CASES: DeriveCase[] = [
    [
      'a transitional state a job owns',
      'deploying',
      [],
      null,
      { state: 'deploying', ready: false, reason: 'transition in progress' },
    ],
    [
      'an instance with no containers at all',
      'failed',
      [],
      null,
      { state: 'failed', ready: false, reason: 'no containers' },
    ],
    [
      'a stopped instance with nothing running',
      'stopped',
      [],
      null,
      { state: 'stopped', ready: false, reason: 'no containers' },
    ],
    [
      'a deliberate stop with the containers still down',
      'stopped',
      [{ state: 'exited' }],
      false,
      { state: 'stopped', ready: false, reason: 'stopped; containers are not running' },
    ],
    [
      'one container down out of two',
      'ready',
      [{ state: 'running' }, { state: 'exited' }],
      true,
      { state: 'degraded', ready: false, reason: '1 of 2 container(s) not running' },
    ],
    [
      'every container running and the product answering',
      'ready',
      [{ state: 'running' }],
      true,
      { state: 'ready', ready: true, reason: null },
    ],
    [
      'every container running but the product not answering',
      'ready',
      [{ state: 'running' }],
      false,
      { state: 'degraded', ready: false, reason: 'HTTP readiness probe failed' },
    ],
    [
      'every container running and no probe attempted',
      'ready',
      [{ state: 'running' }],
      null,
      { state: 'degraded', ready: false, reason: 'HTTP readiness was not probed' },
    ],
  ];

  it.each(CASES)('derives %s', (_name, previous, containers, httpReady, expected) => {
    expect(derive(previous, containers, httpReady)).toEqual(expected);
  });
});
