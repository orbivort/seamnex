import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import { PostgresPlannerService } from '../../../../src/modules/m04-planner/planner.service';

/**
 * The arms the main suite cannot reach by happy path are the ones where a *missing* fact has to
 * become a refusal rather than a crash: the history query may return no row at all (then the
 * instance has no predecessor), and a file whose hash is identical on both sides is not a change.
 * Both were wrong once in the other direction — a rollback offered without a predecessor, and a
 * diff that reported every file as "changed" because it compared nothing.
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

beforeEach(() => {
  h.withTransaction.mockReset();
});

describe('instancePlan', () => {
  it('refuses to offer a rollback when the history query returns no row', async () => {
    const { capacity, renderer, service } = setup([
      ['FROM instance WHERE id', [{ entry_key: 'shop', state: 'ready', payload: {} }]],
      ['FROM deployment_plan', []],
      // `count(*)` always returns one row in PostgreSQL; the reader still has to answer when it
      // does not, because the two-place fallback is what keeps the dialog renderable.
      ['count(*)', []],
    ]);
    capacity.admit.mockResolvedValue({ admissible: true, headline: 'fits', detail: 'ok' });
    renderer.applied.mockResolvedValue({
      id: 'rs-1',
      contentHash: 'abcdef0123456789',
      files: [],
    });

    const plan = await service.instancePlan('inst-1', 'upgrade');

    expect(plan.rollbackAvailable).toBe(false);
    expect(plan.from).toBe('abcdef012345');
  });
});

describe('plan', () => {
  it('reports no change for a file whose hash is identical on both sides', async () => {
    const { renderer, service } = setup([
      ['INSERT INTO deployment_plan', [{ id: 'plan-1' }]],
      ['UPDATE render_set SET plan_id', []],
    ]);
    const unchanged = 'a'.repeat(64);
    renderer.load.mockResolvedValue({ files: [{ path: 'compose.yaml', sha256: unchanged }] });
    renderer.applied.mockResolvedValue({
      id: 'plan-0',
      contentHash: 'irrelevant',
      files: [{ path: 'compose.yaml', sha256: unchanged }],
    });

    const result = await service.plan(planInput());

    // Identical hashes are identical deployments: the dialog must not list a phantom change.
    expect(result.changes).toEqual([]);
    expect(result.rollbackAvailable).toBe(true);
  });
});
