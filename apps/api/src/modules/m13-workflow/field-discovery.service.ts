import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FieldDescriptor } from '@seamnex/domain';
import type { FieldSnapshotRow } from '@seamnex/db';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import {
  WORKFLOW_EGRESS_SERVICE,
  type FieldDiscoveryResult,
  type WorkflowEgressService,
} from '../m25-workflow-egress/egress.contract';
import { FieldSnapshotRepository, snapshotKey } from './field-snapshot.repository';

/** One product schema to read. The instance and the operation together identify it. */
export type FieldTarget = {
  readonly instanceId: string;
  readonly entryKey: string;
  readonly operation: string;
};

/** A repeated "refresh" inside this window reuses the answer instead of dialling the product again. */
const REFRESH_FLOOR_MS = 60_000;
/** A product that did not answer is not dialled again for this long, per instance and operation. */
const FAILURE_BACKOFF_MS = 5 * 60_000;

/**
 * FR-5.5 — cache-first field discovery.
 *
 * The mapper asks "what fields does this operation accept?" every time it opens, and the answer
 * belongs to the product. Calling the product on every open would make authoring depend on its
 * latency, and calling it never would freeze a schema at first sight. The snapshot is therefore the
 * unit of truth: `available` for a day, `unsupported` for a day (schema absence is stable), and
 * `unavailable` for five minutes (an outage is not).
 *
 * One product call per key in flight: two users opening the same node share the answer.
 */
@Injectable()
export class FieldDiscoveryService {
  private readonly logger = new Logger('m13-field-discovery');
  private readonly inFlight = new Map<string, Promise<FieldSnapshotRow>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(WORKFLOW_EGRESS_SERVICE) private readonly egress: WorkflowEgressService,
    @Inject(FieldSnapshotRepository) private readonly snapshots: FieldSnapshotRepository,
  ) {}

  /** Every cached snapshot for these keys, in one query. The validation pass uses this. */
  async cached(
    targets: readonly { instanceId: string; operation: string }[],
  ): Promise<Map<string, FieldSnapshotRow>> {
    return this.snapshots.forKeys(targets);
  }

  /**
   * The snapshot for one operation, reading the product only when the cached answer is missing,
   * expired, or the caller explicitly asked for a refresh past the refresh floor.
   */
  async snapshot(
    target: FieldTarget,
    options: { refresh: boolean; actorId: string },
  ): Promise<FieldSnapshotRow> {
    const existing = await this.snapshots.get(target.instanceId, target.operation);
    if (existing !== null) {
      const age = Date.now() - existing.fetched_at.getTime();
      if (age < REFRESH_FLOOR_MS) return existing;
      const retryAfter = existing.retry_after?.getTime() ?? 0;
      if (retryAfter > Date.now()) return existing;
      if (!options.refresh && age < this.config.SEAMNEX_FIELD_DISCOVERY_TTL_MS) return existing;
    }

    const key = snapshotKey(target.instanceId, target.operation);
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;

    const pass = this.read(target, options.actorId).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pass);
    return pass;
  }

  private async read(target: FieldTarget, actorId: string): Promise<FieldSnapshotRow> {
    const started = Date.now();
    const result: FieldDiscoveryResult = await this.egress
      .discoverFields(target)
      .catch((error: unknown) => ({
        status: 'unavailable' as const,
        detail: `The product schema could not be read: ${messageOf(error)}`,
      }));

    const fields: readonly FieldDescriptor[] = result.status === 'available' ? result.fields : [];
    const detail = result.status === 'available' ? null : result.detail;
    const row = await this.snapshots.upsert({
      instanceId: target.instanceId,
      entryKey: target.entryKey,
      operation: target.operation,
      status: result.status,
      fields,
      detail,
      retryAfter:
        result.status === 'unavailable' ? new Date(Date.now() + FAILURE_BACKOFF_MS) : null,
    });

    await this.audit
      .append({
        action: 'workflow.fields.discovered',
        actorType: 'user',
        actorId,
        targetType: 'instance',
        targetId: target.instanceId,
        outcome: result.status === 'available' ? 'success' : 'failure',
        // Names and verdicts only: the field list itself is not an audit fact, and the product's
        // response never reaches the audit chain.
        detail: {
          entryKey: target.entryKey,
          operation: target.operation,
          status: result.status,
          fieldCount: fields.length,
          durationMs: Date.now() - started,
        },
      })
      // Discovery is an authoring aid; a failed audit row must not fail the drawer that asked.
      .catch((error: unknown) => {
        this.logger.warn(`field discovery audit failed: ${messageOf(error)}`);
      });

    return row;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
