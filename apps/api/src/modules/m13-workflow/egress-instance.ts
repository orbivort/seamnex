import { selectEgressInstance, type EgressMode } from '@seamnex/domain';
import type { Pool } from 'pg';
import { AppError } from '../../common/problem/app-error';

/**
 * The instance a workflow node addresses, or a `422` that names what is missing.
 *
 * Which deployment wins is decided by `selectEgressInstance` in `@seamnex/domain`, because the
 * FR-5.9 gate has to look at **exactly** the instance the run will write to: if authority and
 * compilation picked different deployments, a caller could be authorised against one product and
 * write into another.
 *
 * Resolving first is deliberate: a node whose product publishes no callable deployment cannot run,
 * and finding that out after minting a credential would leave a live scope behind for a definition
 * that never went live.
 */
export async function resolveEgressInstance(
  pool: Pool,
  entryKey: string,
  mode: EgressMode,
): Promise<string> {
  const result = await pool.query<{
    id: string;
    granularity: string | null;
  }>(
    `SELECT i.id, seamnex_effective_granularity(i.id) AS granularity
       FROM instance i WHERE i.entry_key = $1 AND i.deleted_at IS NULL ORDER BY i.id`,
    [entryKey],
  );
  if (result.rows.length === 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: `No deployed ${entryKey} instance to run this node against.`,
      remediation: 'Deploy the product, then activate again.',
    });
  }
  const chosen = selectEgressInstance(
    result.rows.map((row) => ({ instanceId: row.id, granularity: row.granularity })),
    mode,
  );
  if (chosen === undefined) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail:
        mode === 'write'
          ? `No deployed ${entryKey} instance can issue an operation-scoped credential.`
          : `No deployed ${entryKey} instance can issue a credential the platform can broker.`,
      // FR-2.14 — the workflow-mode remediation used to end with "(FR-2.14)". Remediation text
      // is rendered to operators, so the id stays here.
      remediation:
        mode === 'write'
          ? 'Deploy the product, or make the writing node read-only (C-11).'
          : 'Record a verified credential granularity for the product, or make the node read from a product that has one.',
    });
  }
  return chosen.instanceId;
}
