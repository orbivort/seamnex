import { describe, expect, it } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import { PostgresWorkflowService } from '../../../../src/modules/m13-workflow/workflow.service';

/**
 * The joins that may legitimately produce nothing: a run whose nodes were never recorded, a run id
 * that addresses no row, and a write target whose catalog entry carries no product name. Each is a
 * `LEFT JOIN` in the SQL, so each is `null` here, and each has a different honest answer —
 * an empty node list, a `404`, and the entry key as the fallback label.
 */
const WORKFLOW_ID = '6a7088ab-6955-47b2-88a2-797ae750f1a0';
const RUN_ID = '0f0f6f18-4a2b-4a1e-9a15-2f3f8a1f0c11';

function service(routes: Parameters<typeof fakeDb>[0]) {
  const db = fakeDb(routes);
  return {
    db,
    service: new PostgresWorkflowService(
      db.pool,
      {
        lockChain: () => Promise.resolve(),
        append: () => Promise.resolve(),
      } as never,
      { remove: () => Promise.resolve(false) } as never,
    ),
  };
}

function workflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    name: 'Invoice export',
    description: null,
    owner_idp_id: '871a8c71-f44d-44bc-b388-253b182fa76a',
    owner_username: 'dev-admin',
    owner_display_name: 'Dev Admin',
    state: 'active',
    version: 2,
    ir_hash: '91d0be32184a266392a8fab1d69a30854cfeabaeac441e4428e07022825465ad',
    ir: { trigger: { type: 'manual', label: 'Manual', config: null }, nodes: [], edges: [] },
    validated_at: new Date('2026-02-01T00:00:00.000Z'),
    validation_issues: [],
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
    last_run_at: null,
    last_run_state: null,
    total_count: '1',
    ...overrides,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    workflow_id: WORKFLOW_ID,
    workflow_name: 'Invoice export',
    version: 2,
    trigger: 'manual',
    state: 'succeeded',
    started_at: new Date('2026-02-02T10:00:00.000Z'),
    finished_at: new Date('2026-02-02T10:00:02.500Z'),
    idempotency_key: null,
    replay_of: null,
    error: null,
    ...overrides,
  };
}

describe('runs', () => {
  it('reports a run whose nodes were never recorded with an empty node list', async () => {
    const { service: workflows } = service([
      ['SELECT 1 FROM workflow WHERE id', [{ '?column?': 1 }]],
      ['FROM workflow_run r', [runRow()]],
      ['FROM workflow_run_node', []],
    ]);

    const runs = await workflows.runs(WORKFLOW_ID);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      nodes: [],
      durationMs: 2_500,
      finishedAt: '2026-02-02T10:00:02.500Z',
      // No recorded key: the run id is the only identifier the platform has for that run.
      idempotencyKey: RUN_ID,
    });
  });
});

describe('run', () => {
  it('refuses a well-formed run id that addresses no row', async () => {
    const { service: workflows } = service([['FROM workflow_run r', []]]);

    await expect(workflows.run(RUN_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No workflow ${RUN_ID}.`,
    });
  });
});

describe('write targets', () => {
  it('falls back to the entry key when the catalog entry has no product name', async () => {
    const { service: workflows } = service([
      ['count(*) OVER', [workflowRow()]],
      [
        'unnest(w.write_targets)',
        [{ workflow_id: WORKFLOW_ID, entry_key: 'D01-01', product: null }],
      ],
      ['FROM credential_scope', []],
    ]);

    const result = await workflows.list({});
    const [workflow] = result.items;

    expect(workflow?.writeTargets).toEqual([
      { entryKey: 'D01-01', product: 'D01-01', mode: 'write' },
    ]);
  });
});
