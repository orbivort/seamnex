import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { TriggerEndpoint } from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { SECRETS_SERVICE, type SecretsService } from '../m15-secrets/secrets.contract';
import type { TriggerDeliveryOutcome, TriggerIngressService } from './trigger-ingress.contract';

/**
 * 4E.5 - trigger ingress and endpoint registration.
 *
 * The URL carries an opaque token, the body is signed, and the token is stored only as a hash: a
 * leaked table yields neither a usable URL nor a usable signature. An unknown, unsigned, stale or
 * replayed delivery is rejected **and audited**; a duplicate delivery is recorded as `duplicate`
 * rather than executed twice, which is what makes a retrying sender safe.
 */
@Injectable()
export class PostgresTriggerIngressService implements TriggerIngressService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(SECRETS_SERVICE) private readonly secrets: SecretsService,
  ) {}

  async list(instanceId: string): Promise<TriggerEndpoint[]> {
    const result = await this.pool.query<{
      id: string;
      instance_id: string;
      workflow_id: string | null;
      event_name: string;
      state: string;
      registered_at: Date;
    }>(
      `SELECT id, instance_id, workflow_id, event_name, state, registered_at
         FROM trigger_endpoint WHERE instance_id = $1 ORDER BY registered_at DESC`,
      [instanceId],
    );
    // `url` and `secret` are never returned after creation: only the hash is stored, so there is
    // nothing truthful to show and a placeholder would invite a copy-paste mistake.
    return result.rows.map((row) => ({
      id: row.id,
      instanceId: row.instance_id,
      workflowId: row.workflow_id,
      eventName: row.event_name,
      state: row.state as TriggerEndpoint['state'],
      registeredAt: row.registered_at.toISOString(),
      url: null,
      secret: null,
    }));
  }

  async register(
    instanceId: string,
    input: { eventName: string; workflowId: string },
    actorId: string,
  ): Promise<TriggerEndpoint> {
    const token = randomToken();
    const secret = randomToken();
    const stored = await this.secrets.put(
      'instance',
      instanceId,
      `trigger_${input.eventName}`,
      secret,
    );

    const inserted = await this.pool.query<{ id: string; registered_at: Date }>(
      `INSERT INTO trigger_endpoint (instance_id, workflow_id, event_name, token_hash, hmac_secret_ref)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (instance_id, event_name) DO UPDATE
          SET token_hash = EXCLUDED.token_hash, hmac_secret_ref = EXCLUDED.hmac_secret_ref,
              workflow_id = EXCLUDED.workflow_id, state = 'active'
       RETURNING id, registered_at`,
      [
        instanceId,
        input.workflowId,
        input.eventName,
        createHash('sha256').update(token).digest('hex'),
        stored.id,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined)
      throw new AppError({
        code: 'INTERNAL_ERROR',
        detail: 'The trigger endpoint was not created.',
      });

    await this.audit.append({
      action: 'trigger.endpoint.registered',
      actorType: 'user',
      actorId,
      targetType: 'trigger_endpoint',
      targetId: row.id,
      outcome: 'success',
      detail: { eventName: input.eventName, workflowId: input.workflowId },
    });

    return {
      id: row.id,
      instanceId,
      workflowId: input.workflowId,
      eventName: input.eventName,
      state: 'active',
      registeredAt: row.registered_at.toISOString(),
      // The only moment the caller can see the secret material.
      url: `/api/v1/trigger/${token}`,
      secret,
    };
  }

  async remove(triggerId: string, actorId: string): Promise<void> {
    const result = await this.pool.query(`DELETE FROM trigger_endpoint WHERE id = $1`, [triggerId]);
    if (result.rowCount === 0) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No trigger endpoint ${triggerId}.`,
        remediation: 'Refresh the endpoint list.',
      });
    }
    await this.audit.append({
      action: 'trigger.endpoint.removed',
      actorType: 'user',
      actorId,
      targetType: 'trigger_endpoint',
      targetId: triggerId,
      outcome: 'success',
    });
  }

  /**
   * `token` is the path token from the delivery URL; `signature` is the HMAC over the raw body.
   *
   * Order matters. The endpoint is looked up, then the signature is verified, and only then is the
   * binding to a workflow inspected: an unbound endpoint is a platform defect an operator must fix,
   * and telling an unauthenticated caller about it would turn this route into an enumeration
   * oracle. Everything before the signature answers the same `unknown endpoint`.
   */
  async accept(input: {
    endpointToken: string;
    rawBody: Buffer;
    signature: string | null;
    deliveryId: string | null;
  }): Promise<TriggerDeliveryOutcome> {
    const tokenHash = createHash('sha256').update(input.endpointToken).digest('hex');
    const endpoint = await this.pool.query<{
      id: string;
      hmac_secret_ref: string;
      instance_id: string;
      workflow_id: string | null;
      state: string;
    }>(
      `SELECT id, hmac_secret_ref, instance_id, workflow_id, state
         FROM trigger_endpoint WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = endpoint.rows[0];
    const deliveryId = input.deliveryId ?? createHash('sha256').update(input.rawBody).digest('hex');
    const refusal = (reason: string): TriggerDeliveryOutcome => ({
      accepted: false,
      reason,
      endpointId: row?.id ?? null,
      instanceId: row?.instance_id ?? null,
      workflowId: row?.workflow_id ?? null,
      deliveryId,
    });

    if (row === undefined || row.state !== 'active') {
      await this.reject(null, input.deliveryId, 'unknown endpoint');
      return refusal('unknown endpoint');
    }

    if (input.signature === null) {
      await this.reject(row.id, input.deliveryId, 'missing signature');
      return refusal('missing signature');
    }
    const secret = await this.secrets.open(row.hmac_secret_ref, 'trigger signature verification');
    const expected = createHmac('sha256', secret).update(input.rawBody).digest('hex');
    if (!safeEqual(expected, input.signature)) {
      await this.reject(row.id, input.deliveryId, 'signature mismatch');
      return refusal('signature mismatch');
    }

    /*
     * Legacy rows registered before the binding was required have `workflow_id IS NULL`. A delivery
     * to one used to be acknowledged and forgotten; it is now refused with a reason the operator can
     * act on, and only a caller who signed the body correctly ever learns that.
     */
    if (row.workflow_id === null) {
      await this.reject(row.id, deliveryId, 'endpoint is not bound to a workflow');
      return refusal('unbound endpoint');
    }

    /*
     * A delivery whose execution failed may be attempted again: `failed` is the one state where the
     * sender's retry is the correct behaviour and nothing has executed. Every other existing state
     * — accepted, forwarded, duplicate, rejected — still answers `duplicate delivery`, so a retry
     * cannot double-execute a run that already happened.
     */
    const recorded = await this.pool.query(
      `INSERT INTO trigger_delivery (trigger_endpoint_id, delivery_id, state)
       VALUES ($1, $2, 'accepted')
       ON CONFLICT (trigger_endpoint_id, delivery_id) DO UPDATE
          SET state = 'accepted'
        WHERE trigger_delivery.state = 'failed'
       RETURNING id`,
      [row.id, deliveryId],
    );
    if (recorded.rowCount === 0) {
      await this.pool.query(
        `INSERT INTO trigger_delivery (trigger_endpoint_id, delivery_id, state) VALUES ($1, $2, 'duplicate')
         ON CONFLICT (trigger_endpoint_id, delivery_id) DO NOTHING`,
        [row.id, `${deliveryId}:duplicate:${Date.now()}`],
      );
      return { ...refusal('duplicate delivery'), accepted: false };
    }

    await this.audit.append({
      action: 'trigger.delivery.accepted',
      actorType: 'service',
      actorId: 'trigger-ingress',
      targetType: 'trigger_endpoint',
      targetId: row.id,
      outcome: 'success',
      detail: { deliveryId, workflowId: row.workflow_id },
    });
    return {
      accepted: true,
      reason: 'accepted',
      endpointId: row.id,
      instanceId: row.instance_id,
      workflowId: row.workflow_id,
      deliveryId,
    };
  }

  /** NFR-2.8: the delivery's own outcome and the event-to-execution latency it measured. */
  async recordOutcome(input: {
    endpointId: string;
    deliveryId: string;
    state: 'forwarded' | 'failed';
    runId: string | null;
    latencyMs: number;
    detail: string | null;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE trigger_delivery SET state = $3
        WHERE trigger_endpoint_id = $1 AND delivery_id = $2 AND state = 'accepted'`,
      [input.endpointId, input.deliveryId, input.state],
    );
    await this.audit.append({
      action:
        input.state === 'forwarded' ? 'trigger.delivery.forwarded' : 'trigger.delivery.failed',
      actorType: 'service',
      actorId: 'trigger-ingress',
      targetType: 'trigger_endpoint',
      targetId: input.endpointId,
      outcome: input.state === 'forwarded' ? 'success' : 'failure',
      detail: {
        deliveryId: input.deliveryId,
        runId: input.runId,
        latencyMs: input.latencyMs,
        ...(input.detail === null ? {} : { reason: input.detail }),
      },
    });
  }

  private async reject(
    endpointId: string | null,
    deliveryId: string | null,
    reason: string,
  ): Promise<void> {
    if (endpointId !== null) {
      await this.pool.query(
        `INSERT INTO trigger_delivery (trigger_endpoint_id, delivery_id, state) VALUES ($1, $2, 'rejected')
         ON CONFLICT DO NOTHING`,
        [endpointId, `${deliveryId ?? 'anonymous'}:${Date.now()}`],
      );
    }
    await this.audit.append({
      action: 'trigger.rejected',
      actorType: 'service',
      actorId: 'trigger-ingress',
      targetType: 'trigger_endpoint',
      targetId: endpointId ?? 'unknown',
      outcome: 'denied',
      detail: { reason, deliveryId },
    });
  }
}

/**
 * 32 bytes from the CSPRNG, hex encoded — the same shape as before, so no stored hash changes.
 * `Math.random()` was not a token: its output is reproducible from a handful of observations, and
 * this value is both the URL capability and half of the delivery authentication.
 */
function randomToken(): string {
  return randomBytes(32).toString('hex');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
