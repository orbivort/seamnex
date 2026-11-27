import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { fakeDb } from '../../../support/fakes';
import { RunMirrorService } from '../../../../src/modules/m13-workflow/run-mirror.service';

const RUN_ID = '0b0d0e42-1111-4c2a-9a2a-000000000001';
const WORKFLOW_ID = '1c1d1e43-2222-4c2a-9a2a-000000000002';
const NODE_READ = '2d2e2f44-3333-4c2a-9a2a-000000000003';
const NODE_WRITE = '3e3f4a45-4444-4c2a-9a2a-000000000004';

const POLL_MS = 10_000;
const RETENTION_DAYS = 30;
const RUN_RETENTION_DAYS = 90;
const ALERT_THRESHOLD = 3;
const CONFIG = {
  SEAMNEX_N8N_EXECUTION_POLL_MS: POLL_MS,
  SEAMNEX_WORKFLOW_SAMPLE_RETENTION_DAYS: RETENTION_DAYS,
  SEAMNEX_WORKFLOW_RUN_RETENTION_DAYS: RUN_RETENTION_DAYS,
  SEAMNEX_WORKFLOW_FAILURE_ALERT_THRESHOLD: ALERT_THRESHOLD,
} as never;

/** A run in flight, with the two-node IR its node rows were copied from. */
function runningRun(over: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    workflow_id: WORKFLOW_ID,
    started_at: new Date('2026-11-09T15:00:00.000Z'),
    compiled_n8n_id: 'n8n-wf-1',
    ir: {
      nodes: [
        { id: NODE_READ, label: 'Read employees' },
        { id: NODE_WRITE, label: 'Create contact' },
      ],
    },
    ...over,
  };
}

function harness(
  options: {
    runs?: unknown[];
    executions?: unknown[];
    details?: Record<string, unknown>;
    ready?: boolean;
    /** Overrides what the retention sweep answers, for its failure and no-row-count paths. */
    sweep?: unknown;
    auditFails?: boolean;
    /** The trailing failed-run streak the alert pass reads. */
    streak?: number;
    /** Omitted means "this process hosts no notification delivery". */
    notify?: 'queued' | 'suppressed' | 'rejects';
    /** Overrides the owner lookup, for the workflow-deleted-mid-settle path. */
    workflow?: unknown[];
    /** Overrides the streak row, for the no-row-yet path. */
    streakRows?: unknown[];
  } = {},
) {
  const db = fakeDb([
    // The streak read selects from the run table too, so it is matched before the run listing.
    ['count(*)::int AS streak', options.streakRows ?? [{ streak: options.streak ?? 0 }]],
    ['FROM workflow_run r', options.runs ?? [runningRun()]],
    [
      'FROM workflow w',
      options.workflow ?? [
        {
          name: 'Invoice export',
          owner_idp_id: 'idp-owner',
          owner_username: 'owner',
          owner_display_name: 'Owner Person',
        },
      ],
    ],
    ['DELETE FROM workflow_run', []],
    // The sweep is a statement on `workflow_run_node`, so it has to be matched before the
    // per-node write route or the two are indistinguishable.
    ['SET sample_item = NULL', options.sweep ?? []],
    ['UPDATE workflow_run_node', []],
    ['UPDATE workflow_run', []],
  ]);
  const n8n = {
    ready: () => options.ready ?? true,
    executions: vi.fn(async () => options.executions ?? []),
    execution: vi.fn(
      async (id: string) => options.details?.[id] ?? { status: 'running', nodes: [], error: null },
    ),
  };
  const audit = {
    append: vi.fn(async () => {
      if (options.auditFails === true) throw new Error('audit unavailable');
      return undefined;
    }),
  };
  const notifications =
    options.notify === undefined
      ? undefined
      : {
          notify: vi.fn(async (_input: { severity: string; subject: string; body: string }) => {
            if (options.notify === 'rejects') throw new Error('mail server down');
            if (options.notify === 'suppressed') {
              return { queued: false, suppressedBy: 'no channel configured' };
            }
            return { queued: true, suppressedBy: null };
          }),
        };
  const service = new RunMirrorService(
    db.pool,
    CONFIG,
    audit as never,
    n8n as never,
    notifications as never,
  );
  return { db, n8n, audit, notifications, service };
}

/** The run row's terminal write. The retention sweep shares the table prefix, so match its SET. */
function runStatement(db: ReturnType<typeof fakeDb>) {
  return db.calls.find(
    (call) => call.sql.includes('UPDATE workflow_run') && call.sql.includes('SET state = $2'),
  );
}

/** The per-node writes of one settle. Named apart from the sweep for the same reason. */
function nodeStatements(db: ReturnType<typeof fakeDb>) {
  return db.calls.filter(
    (call) => call.sql.includes('UPDATE workflow_run_node') && call.sql.includes('SET state = $3'),
  );
}

function sweepStatement(db: ReturnType<typeof fakeDb>) {
  return db.calls.find((call) => call.sql.includes('SET sample_item = NULL'));
}

describe('RunMirrorService', () => {
  it('settles a failed execution, mirroring the node that failed', async () => {
    const { db, service, audit } = harness({
      executions: [
        { id: '5', finished: false, status: 'error', startedAt: '2026-11-09T15:00:00.100Z' },
      ],
      details: {
        '5': {
          status: 'error',
          stoppedAt: '2026-11-09T15:00:00.700Z',
          error: 'Invalid URL: /employees.read.',
          nodes: [
            {
              name: 'Read employees',
              state: 'failed',
              durationMs: 3,
              records: 0,
              error: 'Invalid URL: /employees.read.',
            },
          ],
        },
      },
    });

    await expect(service.tick()).resolves.toBe(1);

    const run = runStatement(db);
    expect(run?.params?.slice(0, 2)).toEqual([RUN_ID, 'failed']);
    expect(run?.params?.[3]).toBe('{"message":"Invalid URL: /employees.read."}');
    // n8n never started the second node: the row keeps `queued`, which is what "never ran" means
    // in a state set that has no `skipped`.
    const nodes = nodeStatements(db);
    expect(nodes.map((call) => call.params?.[2])).toEqual(['failed', 'queued']);
    // The column is jsonb, so the message is written as an object — a bare string aborts the pass.
    expect(nodes[0]?.params?.slice(3, 5)).toEqual([
      3,
      '{"message":"Invalid URL: /employees.read."}',
    ]);
    expect(nodes[1]?.params?.[4]).toBeNull();
    // A node with no result has no item either, so nothing is stamped as captured.
    expect(nodes[0]?.params?.slice(5, 8)).toEqual([null, null, false]);
    // `finished_at` is n8n's stop, not the moment this pass noticed: the run table's Duration is
    // read by an operator comparing runs, so it must not grow with the poller's cadence.
    expect(run?.params?.[2]).toEqual(new Date('2026-11-09T15:00:00.700Z'));
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.run.failed',
        targetId: RUN_ID,
        outcome: 'failure',
        detail: { workflowId: WORKFLOW_ID, executionId: '5', status: 'error' },
      }),
    );
  });

  it('falls back to the wall clock when n8n reports no stop time', async () => {
    const { db, service } = harness({
      executions: [
        { id: '9', finished: false, status: 'error', startedAt: '2026-11-09T15:00:00.100Z' },
      ],
      details: { '9': { status: 'error', stoppedAt: null, error: 'boom', nodes: [] } },
    });

    await expect(service.tick()).resolves.toBe(1);
    const finishedAt = runStatement(db)?.params?.[2];
    expect(finishedAt).toBeInstanceOf(Date);
    expect(Math.abs((finishedAt as Date).getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('settles a successful execution as succeeded and clears the error', async () => {
    const { db, service, audit } = harness({
      executions: [
        { id: '6', finished: true, status: 'success', startedAt: '2026-11-09T15:00:01.000Z' },
      ],
      details: {
        '6': {
          status: 'success',
          stoppedAt: '2026-11-09T15:00:01.250Z',
          error: null,
          nodes: [
            { name: 'Read employees', state: 'succeeded', durationMs: 12, records: 3, error: null },
            { name: 'Create contact', state: 'succeeded', durationMs: 8, records: 3, error: null },
          ],
        },
      },
    });

    await expect(service.tick()).resolves.toBe(1);
    expect(runStatement(db)?.params?.slice(0, 2)).toEqual([RUN_ID, 'succeeded']);
    expect(runStatement(db)?.params?.[3]).toBeNull();
    expect(nodeStatements(db).map((call) => [call.params?.[2], call.params?.[3]])).toEqual([
      ['succeeded', 12],
      ['succeeded', 8],
    ]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow.run.succeeded', outcome: 'success' }),
    );
  });

  it('keeps the item a node produced, redacted, so the mapper can offer real paths', async () => {
    const { db, service } = harness({
      executions: [
        { id: '11', finished: true, status: 'success', startedAt: '2026-11-09T15:00:00.100Z' },
      ],
      details: {
        '11': {
          status: 'success',
          stoppedAt: '2026-11-09T15:00:00.400Z',
          error: null,
          nodes: [
            {
              name: 'Read employees',
              state: 'succeeded',
              durationMs: 5,
              records: 1,
              error: null,
              sample: { firstName: 'Ada', email: 'ada@example.com', apiToken: 'tok_live_1' },
            },
          ],
        },
      },
    });

    await expect(service.tick()).resolves.toBe(1);

    const write = nodeStatements(db)[0];
    const stored = String(write?.params?.[5]);
    // The field names survive — that is the whole point of the sample — the values do not.
    expect(stored).toContain('"firstName":"Ada"');
    expect(stored).not.toContain('ada@example.com');
    expect(stored).not.toContain('tok_live_1');
    expect(write?.params?.[6]).toBeInstanceOf(Date);
    expect(write?.params?.[7]).toBe(false);
  });

  it('nulls samples past the retention window, and only once per window', async () => {
    const { db, service } = harness({
      executions: [
        { id: '12', finished: true, status: 'success', startedAt: '2026-11-09T15:00:00.100Z' },
      ],
      details: { '12': { status: 'success', stoppedAt: null, error: null, nodes: [] } },
    });

    await expect(service.tick()).resolves.toBe(1);
    expect(sweepStatement(db)?.params).toEqual([RETENTION_DAYS]);

    // The poller ticks every few seconds; the sweep is a whole-table UPDATE, not a per-tick write.
    await expect(service.tick()).resolves.toBe(1);
    expect(db.calls.filter((call) => call.sql.includes('SET sample_item = NULL'))).toHaveLength(1);
  });

  it('still expires samples while the n8n adapter is unconfigured', async () => {
    const { db, service, n8n } = harness({ ready: false });

    await expect(service.tick()).resolves.toBe(0);
    // Disabling n8n stops new captures; it must not stop the expiry of the items already stored.
    expect(n8n.executions).not.toHaveBeenCalled();
    expect(sweepStatement(db)?.params).toEqual([RETENTION_DAYS]);
  });

  it('leaves a run in flight while n8n still reports it as running', async () => {
    const { db, service } = harness({
      executions: [
        { id: '7', finished: false, status: 'running', startedAt: '2026-11-09T15:00:00.400Z' },
      ],
    });

    await expect(service.tick()).resolves.toBe(0);
    expect(runStatement(db)).toBeUndefined();
    expect(nodeStatements(db)).toEqual([]);
  });

  it('does not settle a run whose execution has not been created yet', async () => {
    const { db, service } = harness({ executions: [] });

    await expect(service.tick()).resolves.toBe(0);
    expect(runStatement(db)).toBeUndefined();
    expect(nodeStatements(db)).toEqual([]);
  });

  it('never lets two runs claim one execution', async () => {
    const second = runningRun({
      id: '4a4b4c46-5555-4c2a-9a2a-000000000005',
      started_at: new Date('2026-11-09T15:00:00.500Z'),
    });
    const { db, service } = harness({
      runs: [runningRun(), second],
      executions: [
        { id: '8', finished: true, status: 'success', startedAt: '2026-11-09T15:00:00.200Z' },
      ],
      details: {
        '8': { status: 'success', error: null, nodes: [] },
      },
    });

    await expect(service.tick()).resolves.toBe(1);
    const updates = db.calls.filter(
      (call) => call.sql.includes('UPDATE workflow_run') && !call.sql.includes('workflow_run_node'),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.params?.[0]).toBe(RUN_ID);
  });

  it('does nothing while the n8n adapter is unconfigured', async () => {
    const { service, n8n } = harness({ ready: false });

    await expect(service.tick()).resolves.toBe(0);
    expect(n8n.executions).not.toHaveBeenCalled();
  });

  it('names the failing node when n8n reports no execution-level error', async () => {
    const { db, service } = harness({
      executions: [
        { id: '13', finished: false, status: 'error', startedAt: '2026-11-09T15:00:00.100Z' },
      ],
      details: {
        '13': {
          status: 'error',
          stoppedAt: '2026-11-09T15:00:00.400Z',
          error: null,
          nodes: [
            {
              name: 'Read employees',
              state: 'failed',
              durationMs: 2,
              records: 0,
              error: 'node blew up',
            },
          ],
        },
      },
    });

    await expect(service.tick()).resolves.toBe(1);

    expect(runStatement(db)?.params?.[3]).toBe('{"message":"node blew up"}');
  });

  it('sorts one workflow’s executions by start time so the earliest unclaimed one matches', async () => {
    const { service, audit } = harness({
      executions: [
        { id: 'later', finished: true, status: 'success', startedAt: '2026-11-09T15:00:09.000Z' },
        { id: 'earlier', finished: true, status: 'success', startedAt: '2026-11-09T15:00:01.000Z' },
      ],
      details: {
        earlier: { status: 'success', error: null, nodes: [] },
        later: { status: 'success', error: null, nodes: [] },
      },
    });

    await expect(service.tick()).resolves.toBe(1);

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ executionId: 'earlier' }),
      }),
    );
  });

  it('settles a run even when the audit chain refuses the outcome row', async () => {
    const { db, service } = harness({
      executions: [
        { id: '14', finished: true, status: 'success', startedAt: '2026-11-09T15:00:00.100Z' },
      ],
      details: { '14': { status: 'success', error: null, nodes: [] } },
      auditFails: true,
    });

    await expect(service.tick()).resolves.toBe(1);
    expect(runStatement(db)?.params?.[1]).toBe('succeeded');
  });

  it('keeps polling after a failed retention sweep, and says why it failed', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = harness({
      sweep: () => Promise.reject(new Error('table is locked')),
      executions: [
        { id: '15', finished: true, status: 'success', startedAt: '2026-11-09T15:00:00.100Z' },
      ],
      details: { '15': { status: 'success', error: null, nodes: [] } },
    });

    await expect(service.tick()).resolves.toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('retention sweep failed'));
    warn.mockRestore();
  });

  it('reports no expired samples when the statement returns no row count', async () => {
    const { service } = harness({
      sweep: { rows: [], rowCount: null },
    });

    await expect(service.sweepSamples()).resolves.toBe(0);
  });

  it('logs a failed pass instead of swallowing it', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const { service, n8n } = harness();
      n8n.executions.mockRejectedValueOnce(new Error('n8n gone'));

      service.start();
      await vi.advanceTimersByTimeAsync(POLL_MS);
      service.stop();

      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'n8n gone' }),
        expect.stringContaining('mirror pass failed'),
      );
    } finally {
      vi.useRealTimers();
      error.mockRestore();
    }
  });

  it('keeps one timer however often it is started, and stops on shutdown', async () => {
    vi.useFakeTimers();
    try {
      const { service, n8n } = harness();
      service.start();
      service.start();
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(n8n.executions).toHaveBeenCalledTimes(1);

      service.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(n8n.executions).toHaveBeenCalledTimes(1);

      // Stopping a poller that was never started is not an error.
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls on its own interval, not on the scheduler pass', async () => {
    // The defect this pins: `start()` was never called, so the only driver was the scheduler's
    // one-minute pass and a 265 ms run stayed `Running` for up to a minute.
    vi.useFakeTimers();
    try {
      const { service, n8n } = harness({
        executions: [
          { id: '10', finished: true, status: 'success', startedAt: '2026-11-09T15:00:00.100Z' },
        ],
        details: {
          '10': {
            status: 'success',
            stoppedAt: '2026-11-09T15:00:00.400Z',
            error: null,
            nodes: [],
          },
        },
      });

      service.start();
      await vi.advanceTimersByTimeAsync(POLL_MS);

      expect(n8n.executions).toHaveBeenCalledTimes(1);
      service.stop();
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(n8n.executions).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A failed execution whose first node was retried `tries` times before the run gave up. */
function failedExecution(tries: number) {
  return {
    executions: [
      { id: '21', finished: false, status: 'error', startedAt: '2026-11-09T15:00:00.100Z' },
    ],
    details: {
      '21': {
        status: 'error',
        stoppedAt: '2026-11-09T15:00:00.900Z',
        error: null,
        nodes: [
          {
            name: 'Read employees',
            state: 'failed',
            durationMs: 40,
            records: 0,
            error: 'broker answered 502',
            tries,
          },
        ],
      },
    },
  };
}

describe('RunMirrorService attempts and failure alerts', () => {
  /** FR-5.7: the attempt column is what n8n observed, not the constant it used to be. */
  it('records how many attempts a step actually took', async () => {
    const { db, service } = harness(failedExecution(3));

    await expect(service.tick()).resolves.toBe(1);

    expect(nodeStatements(db)[0]?.params?.[8]).toBe(3);
  });

  it('still says one attempt when the step succeeded first time', async () => {
    const { db, service } = harness({
      executions: [
        { id: '22', finished: true, status: 'success', startedAt: '2026-11-09T15:00:00.100Z' },
      ],
      details: {
        '22': {
          status: 'success',
          stoppedAt: null,
          error: null,
          nodes: [
            { name: 'Read employees', state: 'succeeded', durationMs: 4, records: 1, error: null },
          ],
        },
      },
    });

    await expect(service.tick()).resolves.toBe(1);
    expect(nodeStatements(db)[0]?.params?.[8]).toBe(1);
  });

  /**
   * FR-5.8 — "alerting to the workflow owner on repeated failure". The milestone is the threshold,
   * and the alert names the workflow, the run and the step that failed.
   */
  it('alerts the owner when the failures reach the threshold', async () => {
    const { service, notifications, audit } = harness({
      ...failedExecution(3),
      streak: 3,
      notify: 'queued',
    });

    await expect(service.tick()).resolves.toBe(1);

    expect(notifications?.notify).toHaveBeenCalledTimes(1);
    expect(notifications?.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warning',
        subject: 'Workflow "Invoice export" failed 3 runs in a row',
        body: expect.stringContaining('Read employees'),
      }),
    );
    expect(notifications?.notify).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining(RUN_ID) }),
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.run.alerted',
        targetId: RUN_ID,
        detail: expect.objectContaining({ streak: 3, threshold: ALERT_THRESHOLD }),
      }),
    );
  });

  it('keeps quiet below the threshold and between milestones', async () => {
    const below = harness({ ...failedExecution(2), streak: 2, notify: 'queued' });
    await expect(below.service.tick()).resolves.toBe(1);
    expect(below.notifications?.notify).not.toHaveBeenCalled();

    // Four failures with a threshold of three is the same streak as three: one alert, not two.
    const between = harness({ ...failedExecution(2), streak: 4, notify: 'queued' });
    await expect(between.service.tick()).resolves.toBe(1);
    expect(between.notifications?.notify).not.toHaveBeenCalled();
  });

  it('escalates the severity once a streak passes its first milestone', async () => {
    const { service, notifications } = harness({
      ...failedExecution(3),
      streak: 6,
      notify: 'queued',
    });

    await expect(service.tick()).resolves.toBe(1);

    expect(notifications?.notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical' }),
    );
  });

  /**
   * The channel has none configured, or it suppressed the message: that is not an error, but the
   * audit row must say so rather than record an alert that never left the platform.
   */
  it('records an alert the channel refused as a failure, not as delivered', async () => {
    const { service, audit } = harness({
      ...failedExecution(3),
      streak: 3,
      notify: 'suppressed',
    });

    await expect(service.tick()).resolves.toBe(1);

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.run.alerted',
        outcome: 'failure',
        detail: expect.objectContaining({ queued: false, suppressedBy: 'no channel configured' }),
      }),
    );
  });

  it('still alerts when the failed step cannot be named', async () => {
    const { service, notifications } = harness({
      streak: 3,
      notify: 'queued',
      executions: [
        { id: '24', finished: false, status: 'error', startedAt: '2026-11-09T15:00:00.100Z' },
      ],
      // n8n reported an execution-level error with no per-node detail.
      details: { '24': { status: 'error', stoppedAt: null, error: null, nodes: [] } },
    });

    await expect(service.tick()).resolves.toBe(1);

    expect(notifications?.notify).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('n8n reported a failure.') }),
    );
  });

  it('keeps a long error to a readable length', async () => {
    const long = 'x'.repeat(400);
    const { service, notifications } = harness({
      streak: 3,
      notify: 'queued',
      executions: [
        { id: '25', finished: false, status: 'error', startedAt: '2026-11-09T15:00:00.100Z' },
      ],
      details: {
        '25': {
          status: 'error',
          stoppedAt: null,
          error: long,
          nodes: [],
        },
      },
    });

    await expect(service.tick()).resolves.toBe(1);

    const body = notifications?.notify.mock.calls[0]?.[0]?.body as string | undefined;
    expect(body).toContain('…');
    expect(body?.length).toBeLessThan(long.length);
  });

  /** A workflow deleted between settle and alert is not a failure: there is nobody to tell. */
  /** An aggregate always answers one row; an empty answer means "not countable", not "alert". */
  it('treats an uncountable streak as zero', async () => {
    const { service, notifications } = harness({
      ...failedExecution(3),
      notify: 'queued',
      streakRows: [],
    });

    await expect(service.tick()).resolves.toBe(1);
    expect(notifications?.notify).not.toHaveBeenCalled();
  });

  it('says nothing when the workflow no longer exists', async () => {
    const { service, notifications, audit } = harness({
      ...failedExecution(3),
      streak: 3,
      notify: 'queued',
      workflow: [],
    });

    await expect(service.tick()).resolves.toBe(1);

    expect(notifications?.notify).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow.run.alerted' }),
    );
  });

  it('never alerts about a run that succeeded', async () => {
    const { service, notifications } = harness({
      streak: 3,
      notify: 'queued',
      executions: [
        { id: '23', finished: true, status: 'success', startedAt: '2026-11-09T15:00:00.100Z' },
      ],
      details: { '23': { status: 'success', stoppedAt: null, error: null, nodes: [] } },
    });

    await expect(service.tick()).resolves.toBe(1);
    expect(notifications?.notify).not.toHaveBeenCalled();
  });

  it('settles the run even when the alert cannot be queued', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { db, service } = harness({ ...failedExecution(3), streak: 3, notify: 'rejects' });

    await expect(service.tick()).resolves.toBe(1);
    expect(runStatement(db)?.params?.[1]).toBe('failed');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failure alert could not be queued'));
    warn.mockRestore();
  });

  /** A process without M20 settles runs and raises no alert; it must not pay for the streak query. */
  it('skips the alert entirely when notification delivery is not hosted here', async () => {
    const { db, service } = harness(failedExecution(3));

    await expect(service.tick()).resolves.toBe(1);
    expect(db.calls.filter((call) => call.sql.includes('count(*)::int AS streak'))).toHaveLength(0);
  });

  /** FR-5.8 — runs are retained for the configured window, failures for twice as long. */
  it('deletes run history on the two windows, and only for settled runs', async () => {
    const { db, service } = harness();

    await expect(service.sweepRuns()).resolves.toBe(0);

    const deletes = db.calls.filter((call) => call.sql.includes('DELETE FROM workflow_run'));
    expect(deletes.map((call) => call.params)).toEqual([
      [RUN_RETENTION_DAYS],
      [RUN_RETENTION_DAYS * 2],
    ]);
    expect(deletes[0]?.sql).toContain("state = 'succeeded'");
    expect(deletes[1]?.sql).toContain("state = 'failed'");
    // A run whose outcome was never mirrored is evidence, not history: retention must not erase it.
    expect(
      deletes.some((call) => call.sql.includes("'queued'") || call.sql.includes("'running'")),
    ).toBe(false);
  });

  it('sweeps run history on the same hourly pass as the samples', async () => {
    const { db, service } = harness({ executions: [] });

    await expect(service.tick()).resolves.toBe(0);

    expect(db.calls.filter((call) => call.sql.includes('DELETE FROM workflow_run'))).toHaveLength(
      2,
    );
  });
});
