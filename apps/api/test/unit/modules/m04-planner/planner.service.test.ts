import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import { PostgresPlannerService } from '../../../../src/modules/m04-planner/planner.service';

/**
 * The planner is the only place a deployment's *asserted* diff is produced, and the upgrade dialog
 * reads its projection. Two properties matter and neither is visible through the contract: the diff
 * is computed from file hashes (so it cannot disagree with what the executor applies), and a
 * rollback is offered only when a predecessor exists (otherwise the console offers a recovery
 * affordance that cannot recover).
 */
const h = vi.hoisted(() => ({ withTransaction: vi.fn() }));
vi.mock('@seamnex/db', () => ({ withTransaction: h.withTransaction }));

function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const db = fakeDb(routes);
  h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
    fn(db.client),
  );
  const renderer = { load: vi.fn(), applied: vi.fn() };
  const capacity = { admit: vi.fn() };
  const service = new PostgresPlannerService(db.pool, renderer as never, capacity as never);
  return { db, renderer, capacity, service };
}

function planInput(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: 'inst-1',
    renderSetId: 'rs-2',
    action: 'upgrade',
    capacity: { source: 'measured', admissible: true, headline: 'fits', detail: 'ok' },
    policyVerdict: 'allowed',
    preUpgradeBackup: true,
    ...overrides,
  } as never;
}

const PLAN_ROW = {
  id: 'plan-1',
  instance_id: 'inst-1',
  action: 'upgrade',
  render_set_id: 'rs-2',
  diff: {
    changes: [{ field: 'file:compose.yaml', from: 'old', to: 'new' }],
    preUpgradeBackup: true,
    rollbackFrom: 'plan-0',
  },
  capacity_verdict: 'admitted' as const,
  policy_verdict: 'allowed' as const,
  created_at: new Date(),
};

beforeEach(() => {
  h.withTransaction.mockReset();
});

describe('plan', () => {
  it('records a plan for a first deployment, diffing against nothing', async () => {
    const { db, renderer, service } = setup([
      ['INSERT INTO deployment_plan', [{ id: 'plan-1' }]],
      ['UPDATE render_set SET plan_id', []],
    ]);
    renderer.load.mockResolvedValue({ files: [{ path: 'compose.yaml', sha256: 'a'.repeat(64) }] });
    renderer.applied.mockResolvedValue(null);

    const result = await service.plan(planInput());

    expect(result).toMatchObject({
      planId: 'plan-1',
      instanceId: 'inst-1',
      action: 'upgrade',
      renderSetId: 'rs-2',
      capacityVerdict: 'admitted',
      policyVerdict: 'allowed',
      preUpgradeBackup: true,
      rollbackAvailable: false,
    });
    expect(result.changes).toEqual([
      { field: 'file:compose.yaml', from: 'absent', to: 'a'.repeat(12) },
    ]);

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO deployment_plan'));
    const diff = JSON.parse(String(insert?.params[3])) as Record<string, unknown>;
    expect(diff).toMatchObject({ preUpgradeBackup: true, rollbackFrom: null });
    expect(insert?.params[4]).toBe('admitted');
    expect(insert?.params[5]).toBe('allowed');
    expect(db.calls.some((call) => call.sql.includes('UPDATE render_set SET plan_id'))).toBe(true);
  });

  it('diffs added, changed and removed files by hash', async () => {
    const { renderer, service } = setup([
      ['INSERT INTO deployment_plan', [{ id: 'plan-2' }]],
      ['UPDATE render_set SET plan_id', []],
    ]);
    renderer.load.mockResolvedValue({
      files: [
        { path: 'compose.yaml', sha256: 'b'.repeat(64) },
        { path: 'new.env', sha256: 'c'.repeat(64) },
      ],
    });
    renderer.applied.mockResolvedValue({
      id: 'plan-0',
      contentHash: 'old',
      files: [
        { path: 'compose.yaml', sha256: 'a'.repeat(64) },
        { path: 'gone.env', sha256: 'd'.repeat(64) },
      ],
    });

    const result = await service.plan(planInput());

    expect(result.changes).toEqual([
      { field: 'file:compose.yaml', from: 'a'.repeat(12), to: 'b'.repeat(12) },
      { field: 'file:gone.env', from: 'd'.repeat(12), to: 'removed' },
      { field: 'file:new.env', from: 'absent', to: 'c'.repeat(12) },
    ]);
    expect(result.rollbackAvailable).toBe(true);
  });

  it('caps the diff so one huge tree cannot bloat the row', async () => {
    const { renderer, service } = setup([
      ['INSERT INTO deployment_plan', [{ id: 'plan-3' }]],
      ['UPDATE render_set SET plan_id', []],
    ]);
    renderer.load.mockResolvedValue({
      files: Array.from({ length: 60 }, (_, index) => ({
        path: `f${String(index).padStart(2, '0')}`,
        sha256: 'e'.repeat(64),
      })),
    });
    renderer.applied.mockResolvedValue(null);

    const result = await service.plan(planInput());
    expect(result.changes).toHaveLength(50);
  });

  it.each([
    [{ source: 'unknown' }, 'unknown'],
    [{ source: 'measured', admissible: true }, 'admitted'],
    [{ source: 'measured', admissible: false }, 'refused'],
  ])('maps the capacity verdict %#', async (capacity, expected) => {
    const { renderer, service } = setup([
      ['INSERT INTO deployment_plan', [{ id: 'plan-4' }]],
      ['UPDATE render_set SET plan_id', []],
    ]);
    renderer.load.mockResolvedValue({ files: [] });
    renderer.applied.mockResolvedValue(null);

    const result = await service.plan(
      planInput({ capacity: { headline: 'h', detail: 'd', ...capacity } }),
    );
    expect(result.capacityVerdict).toBe(expected);
  });

  it('fails when the plan row is not returned', async () => {
    const { renderer, service } = setup([['INSERT INTO deployment_plan', []]]);
    renderer.load.mockResolvedValue({ files: [] });
    renderer.applied.mockResolvedValue(null);

    await expect(service.plan(planInput())).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

describe('latest', () => {
  it('returns null when no plan exists', async () => {
    const { service } = setup([['FROM deployment_plan', []]]);
    await expect(service.latest('inst-1')).resolves.toBeNull();
  });

  it('projects a stored plan, defaulting a plan recorded without a diff', async () => {
    const { db, service } = setup([
      [
        'FROM deployment_plan',
        [
          {
            ...PLAN_ROW,
            diff: null,
            render_set_id: null,
            capacity_verdict: null,
            policy_verdict: null,
          },
        ],
      ],
    ]);

    const result = await service.latest('inst-1', 'upgrade');

    expect(result).toEqual({
      planId: 'plan-1',
      instanceId: 'inst-1',
      action: 'upgrade',
      renderSetId: '',
      changes: [],
      capacityVerdict: 'unknown',
      policyVerdict: 'allowed',
      // No recorded flag, but the action implies a pre-upgrade backup.
      preUpgradeBackup: true,
      rollbackAvailable: false,
    });
    expect(db.calls[0]?.params).toEqual(['inst-1', 'upgrade']);
  });

  it('passes a null action when none is requested', async () => {
    const { db, service } = setup([['FROM deployment_plan', [PLAN_ROW]]]);
    await service.latest('inst-1');

    expect(db.calls[0]?.params).toEqual(['inst-1', null]);
  });

  it('reports the recorded diff and rollback source', async () => {
    const { service } = setup([['FROM deployment_plan', [PLAN_ROW]]]);
    const result = await service.latest('inst-1');

    expect(result).toMatchObject({
      changes: [{ field: 'file:compose.yaml', from: 'old', to: 'new' }],
      preUpgradeBackup: true,
      rollbackAvailable: true,
      capacityVerdict: 'admitted',
    });
  });
});

describe('instancePlan', () => {
  const INSTANCE = {
    entry_key: 'shop',
    state: 'ready',
    payload: { resources: { cpu: 2, memoryMb: 2048, diskMb: 4096 } },
  };

  it('projects the upgrade dialog from the instance, capacity, plan and history', async () => {
    const { capacity, renderer, service } = setup([
      ['FROM instance WHERE id', [INSTANCE]],
      ['FROM deployment_plan', [{ ...PLAN_ROW, render_set_id: 'abcdef0123456789' }]],
      ['count(*)', [{ count: '2' }]],
    ]);
    capacity.admit.mockResolvedValue({ admissible: true, headline: 'fits', detail: 'ok' });
    renderer.applied.mockResolvedValue({ id: 'rs-1', contentHash: 'fedcba9876543210', files: [] });

    const plan = await service.instancePlan('inst-1', 'upgrade');

    expect(plan).toMatchObject({
      action: 'upgrade',
      instanceId: 'inst-1',
      from: 'fedcba987654',
      to: 'abcdef012345',
      preUpgradeBackup: true,
      rollbackAvailable: true,
      capacityVerdict: { admissible: true, headline: 'fits', detail: 'ok' },
      changes: [{ field: 'file:compose.yaml', from: 'old', to: 'new' }],
    });
    expect(capacity.admit).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      resources: { cpuMilli: 2_000, memoryMb: 2_048, diskMb: 4_096 },
    });
  });

  it('uses default resources and placeholder text for an instance that was never deployed', async () => {
    const { capacity, renderer, service } = setup([
      ['FROM instance WHERE id', [{ ...INSTANCE, payload: {} }]],
      ['FROM deployment_plan', []],
      ['count(*)', [{ count: '0' }]],
    ]);
    capacity.admit.mockResolvedValue({ admissible: false, headline: 'full', detail: 'no room' });
    renderer.applied.mockResolvedValue(null);

    const plan = await service.instancePlan('inst-1', 'deploy' as never);

    expect(plan).toMatchObject({
      from: 'not deployed',
      to: 'pending render',
      changes: [],
      preUpgradeBackup: false,
      rollbackAvailable: false,
    });
    expect(capacity.admit).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      resources: { cpuMilli: 1_000, memoryMb: 1_024, diskMb: 2_048 },
    });
  });

  it('refuses a plan for an instance that does not exist', async () => {
    const { service } = setup([['FROM instance WHERE id', []]]);
    await expect(service.instancePlan('missing', 'upgrade')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
