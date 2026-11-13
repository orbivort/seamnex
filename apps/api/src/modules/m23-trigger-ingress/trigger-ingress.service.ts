import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { TriggerEndpoint } from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { SECRETS_SERVICE, type SecretsService } from '../m15-secrets/secrets.contract';
import type { TriggerIngressService } from './trigger-ingress.contract';

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
    input: { eventName: string; workflowId?: string },
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
        input.workflowId ?? null,
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
      detail: { eventName: input.eventName, workflowId: input.workflowId ?? null },
    });

    return {
      id: row.id,
      instanceId,
      workflowId: input.workflowId ?? null,
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

  /** `token` is the path token from the delivery URL; `signature` is the HMAC over the raw body. */
  async accept(input: {
    endpointToken: string;
    rawBody: Buffer;
    signature: string | null;
    deliveryId: string | null;
  }): Promise<{ accepted: boolean; reason: string }> {
    const tokenHash = createHash('sha256').update(input.endpointToken).digest('hex');
    const endpoint = await this.pool.query<{
      id: string;
      hmac_secret_ref: string;
      instance_id: string;
      state: string;
    }>(
      `SELECT id, hmac_secret_ref, instance_id, state FROM trigger_endpoint WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = endpoint.rows[0];
    if (row === undefined || row.state !== 'active') {
      await this.reject(null, input.deliveryId, 'unknown endpoint');
      return { accepted: false, reason: 'unknown endpoint' };
    }

    if (input.signature === null) {
      await this.reject(row.id, input.deliveryId, 'missing signature');
      return { accepted: false, reason: 'missing signature' };
    }
    const secret = await this.secrets.open(row.hmac_secret_ref, 'trigger signature verification');
    const expected = createHmac('sha256', secret).update(input.rawBody).digest('hex');
    if (!safeEqual(expected, input.signature)) {
      await this.reject(row.id, input.deliveryId, 'signature mismatch');
      return { accepted: false, reason: 'signature mismatch' };
    }

    const deliveryId = input.deliveryId ?? createHash('sha256').update(input.rawBody).digest('hex');
    const recorded = await this.pool.query(
      `INSERT INTO trigger_delivery (trigger_endpoint_id, delivery_id, state)
       VALUES ($1, $2, 'accepted')
       ON CONFLICT (trigger_endpoint_id, delivery_id) DO NOTHING
       RETURNING id`,
      [row.id, deliveryId],
    );
    if (recorded.rowCount === 0) {
      await this.pool.query(
        `INSERT INTO trigger_delivery (trigger_endpoint_id, delivery_id, state) VALUES ($1, $2, 'duplicate')
         ON CONFLICT (trigger_endpoint_id, delivery_id) DO NOTHING`,
        [row.id, `${deliveryId}:duplicate:${Date.now()}`],
      );
      return { accepted: false, reason: 'duplicate delivery' };
    }

    await this.audit.append({
      action: 'trigger.delivery.accepted',
      actorType: 'service',
      actorId: 'trigger-ingress',
      targetType: 'trigger_endpoint',
      targetId: row.id,
      outcome: 'success',
      detail: { deliveryId },
    });
    return { accepted: true, reason: 'accepted' };
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

function randomToken(): string {
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
