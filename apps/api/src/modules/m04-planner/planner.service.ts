import { Inject, Injectable } from '@nestjs/common';
import type { InstancePlan } from '@seamnex/domain';
import type { Pool } from 'pg';
import { withTransaction } from '@seamnex/db';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { RENDERER_SERVICE, type RendererService } from '../m03-renderer/renderer.contract';
import { CAPACITY_SERVICE, type CapacityService } from '../m19-capacity/capacity.contract';
import type { PlanChange, PlanInput, PlanRecord, PlannerService } from './planner.contract';

const MAX_CHANGES = 50;

type PlanRow = {
  id: string;
  instance_id: string;
  action: string;
  render_set_id: string | null;
  diff: unknown;
  capacity_verdict: 'admitted' | 'refused' | 'unknown' | null;
  policy_verdict: 'allowed' | 'blocked' | 'unsafe_approved' | null;
  created_at: Date;
};

/**
 * 4A.4 — the planner.
 *
 * The diff is computed from the applied render set and the candidate, by file hash rather than by
 * parsing YAML again: two render sets with identical hashes are identical deployments, and a diff
 * built from anything else can disagree with what the executor will apply.
 */
@Injectable()
export class PostgresPlannerService implements PlannerService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(RENDERER_SERVICE) private readonly renderer: RendererService,
    @Inject(CAPACITY_SERVICE) private readonly capacity: CapacityService,
  ) {}

  async plan(input: PlanInput): Promise<PlanRecord> {
    const candidate = await this.renderer.load(input.renderSetId);
    const current = await this.renderer.applied(input.instanceId);
    const changes = diff(current?.files ?? [], candidate.files);

    const capacityVerdict: PlanRecord['capacityVerdict'] =
      input.capacity.source === 'unknown'
        ? 'unknown'
        : input.capacity.admissible
          ? 'admitted'
          : 'refused';

    const planId = await withTransaction(this.pool, async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO deployment_plan
           (instance_id, render_set_id, action, diff, capacity_verdict, policy_verdict)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING id`,
        [
          input.instanceId,
          input.renderSetId,
          input.action,
          JSON.stringify({
            changes,
            capacity: input.capacity,
            preUpgradeBackup: input.preUpgradeBackup,
            rollbackFrom: current?.id ?? null,
          }),
          capacityVerdict,
          input.policyVerdict,
        ],
      );
      const id = inserted.rows[0]?.id;
      if (id === undefined) {
        throw new AppError({
          code: 'INTERNAL_ERROR',
          detail: 'The deployment plan could not be recorded.',
          remediation: 'Retry; no container was started.',
        });
      }
      // `render_set.plan_id` and `deployment_plan.render_set_id` point at each other; the FK is
      // deferred to commit precisely so this update can happen after the insert.
      await tx.query(`UPDATE render_set SET plan_id = $2 WHERE id = $1 AND plan_id IS NULL`, [
        input.renderSetId,
        id,
      ]);
      return id;
    });

    return {
      planId,
      instanceId: input.instanceId,
      action: input.action,
      renderSetId: input.renderSetId,
      changes,
      capacityVerdict,
      policyVerdict: input.policyVerdict,
      preUpgradeBackup: input.preUpgradeBackup,
      rollbackAvailable: current !== null,
    };
  }

  async latest(instanceId: string, action?: string): Promise<PlanRecord | null> {
    const result = await this.pool.query<PlanRow>(
      `SELECT id, instance_id, action, render_set_id, diff, capacity_verdict, policy_verdict, created_at
         FROM deployment_plan
        WHERE instance_id = $1 AND ($2::text IS NULL OR action = $2)
        ORDER BY created_at DESC LIMIT 1`,
      [instanceId, action ?? null],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const diff = (row.diff ?? {}) as {
      changes?: PlanChange[];
      preUpgradeBackup?: boolean;
      rollbackFrom?: string | null;
    };
    return {
      planId: row.id,
      instanceId: row.instance_id,
      action: row.action,
      renderSetId: row.render_set_id ?? '',
      changes: diff.changes ?? [],
      capacityVerdict: row.capacity_verdict ?? 'unknown',
      policyVerdict: row.policy_verdict ?? 'allowed',
      preUpgradeBackup: diff.preUpgradeBackup ?? row.action === 'upgrade',
      rollbackAvailable: (diff.rollbackFrom ?? null) !== null,
    };
  }

  /**
   * The read projection for the upgrade dialog. It never resolves a source: the wizard must render
   * instantly, and a plan whose cost is a git clone belongs in the job, not in a GET.
   */
  async instancePlan(instanceId: string, action: string): Promise<InstancePlan> {
    const instance = await this.pool.query<{
      entry_key: string;
      state: string;
      payload: Record<string, unknown>;
    }>(`SELECT entry_key, state, payload FROM instance WHERE id = $1 AND deleted_at IS NULL`, [
      instanceId,
    ]);
    const row = instance.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No instance ${instanceId}.`,
        remediation: 'Refresh the instance list.',
      });
    }

    const payload = row.payload;
    const resources = (payload.resources ?? {}) as {
      cpu?: number;
      memoryMb?: number;
      diskMb?: number;
    };
    const decision = await this.capacity.admit({
      instanceId,
      resources: {
        cpuMilli: Math.round((resources.cpu ?? 1) * 1000),
        memoryMb: resources.memoryMb ?? 1024,
        diskMb: resources.diskMb ?? 2048,
      },
    });
    // The requested resources are already allocated to this instance, so admission here asks
    // "does this instance still fit", which is exactly the upgrade question.
    const plan = await this.latest(instanceId, action);
    const applied = await this.renderer.applied(instanceId);
    /**
     * A rollback needs a *predecessor*, not merely an applied set. `applied !== null` answered
     * "something was deployed", so the console offered a one-step rollback on an instance that had
     * exactly one render set in its history and the job then failed with "no previous render set" —
     * a recovery affordance that cannot recover.
     */
    const history = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM render_set WHERE instance_id = $1 AND applied_at IS NOT NULL`,
      [instanceId],
    );
    const appliedSets = Number(history.rows[0]?.count ?? '0');

    return {
      action,
      instanceId,
      from: applied === null ? 'not deployed' : applied.contentHash.slice(0, 12),
      to: plan === null ? 'pending render' : plan.renderSetId.slice(0, 12),
      changes: [...(plan?.changes ?? [])],
      preUpgradeBackup: action === 'upgrade',
      capacityVerdict: {
        admissible: decision.admissible,
        headline: decision.headline,
        detail: decision.detail,
      },
      rollbackAvailable: appliedSets > 1,
    };
  }
}

/** File-level diff: added, changed and removed paths, capped so one huge tree cannot bloat a row. */
function diff(
  before: readonly { path: string; sha256: string }[],
  after: readonly { path: string; sha256: string }[],
): PlanChange[] {
  const previous = new Map(before.map((file) => [file.path, file.sha256]));
  const next = new Map(after.map((file) => [file.path, file.sha256]));
  const changes: PlanChange[] = [];

  for (const [path, hash] of next) {
    const old = previous.get(path);
    if (old === undefined)
      changes.push({ field: `file:${path}`, from: 'absent', to: hash.slice(0, 12) });
    else if (old !== hash)
      changes.push({ field: `file:${path}`, from: old.slice(0, 12), to: hash.slice(0, 12) });
  }
  for (const [path, hash] of previous) {
    if (!next.has(path))
      changes.push({ field: `file:${path}`, from: hash.slice(0, 12), to: 'removed' });
  }

  return changes.sort((a, b) => a.field.localeCompare(b.field)).slice(0, MAX_CHANGES);
}
