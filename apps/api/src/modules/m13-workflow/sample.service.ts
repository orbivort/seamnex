import { Inject, Injectable } from '@nestjs/common';
import type { NodeSample } from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';

type IrEdge = { source: string; target: string };
type IrNode = { id: string };

/**
 * FR-5.5 — the redacted item a node last received.
 *
 * n8n stores each node's **output** items, and a mapping's `from` path is evaluated against
 * `$json` of the *previous* node. So the answer for node X is the sample captured on the source of
 * X's inbound edge, not X's own output. A trigger node has no inbound edge and is its own source:
 * its output is the delivery the workflow received.
 *
 * Reading this is audited (node id only, never the item): it is production data, and "who looked at
 * the payload" is a question an auditor asks after an incident.
 */
@Injectable()
export class WorkflowSampleService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  async latest(workflowId: string, nodeId: string, actorId: string): Promise<NodeSample> {
    const version = await this.pool.query<{ ir: { nodes?: IrNode[]; edges?: IrEdge[] } }>(
      `SELECT v.ir FROM workflow w
         JOIN workflow_version v ON v.id = w.current_version_id
        WHERE w.id = $1`,
      [workflowId],
    );
    const ir = version.rows[0]?.ir;
    if (ir === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        status: 404,
        detail: `No workflow ${workflowId} with a current version.`,
      });
    }
    const nodes = Array.isArray(ir.nodes) ? ir.nodes : [];
    if (!nodes.some((entry) => entry.id === nodeId)) {
      throw new AppError({
        code: 'NOT_FOUND',
        status: 404,
        detail: `Node ${nodeId} is not part of this definition.`,
        remediation: 'Reload the workflow: the node may have been removed in a newer version.',
      });
    }
    const inbound = (Array.isArray(ir.edges) ? ir.edges : []).find(
      (edge) => edge.target === nodeId,
    );
    const sourceNodeId = inbound?.source ?? nodeId;

    const found = await this.pool.query<{
      run_id: string;
      sample_item: unknown;
      sample_captured_at: Date | null;
      sample_truncated: boolean;
    }>(
      `SELECT rn.run_id, rn.sample_item, rn.sample_captured_at, rn.sample_truncated
         FROM workflow_run_node rn
         JOIN workflow_run r ON r.id = rn.run_id
        WHERE r.workflow_id = $1 AND rn.node_id = $2 AND rn.sample_item IS NOT NULL
        ORDER BY r.started_at DESC
        LIMIT 1`,
      [workflowId, sourceNodeId],
    );
    const row = found.rows[0];

    await this.audit
      .append({
        action: 'workflow.sample.read',
        actorType: 'user',
        actorId,
        targetType: 'workflow',
        targetId: workflowId,
        outcome: 'success',
        detail: { nodeId, sourceNodeId, found: row !== undefined },
      })
      .catch(() => undefined);

    return {
      nodeId,
      sourceNodeId,
      runId: row?.run_id ?? null,
      capturedAt: row?.sample_captured_at?.toISOString() ?? null,
      item: row?.sample_item ?? null,
      truncated: row?.sample_truncated === true,
    };
  }
}
