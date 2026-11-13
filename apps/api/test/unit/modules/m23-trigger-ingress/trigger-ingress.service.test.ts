import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import { PostgresTriggerIngressService } from '../../../../src/modules/m23-trigger-ingress/trigger-ingress.service';

/**
 * Trigger ingress is the one unauthenticated write path into a workflow, so every refusal is
 * asserted together with its audit entry: an unknown token, a missing signature, a wrong signature
 * and a replayed delivery all have to be *recorded* refusals, not silent drops. The signature is
 * computed with the real HMAC so the comparison path (including the length guard) is exercised.
 */
function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  // A rejection always writes a delivery row; the default keeps the refusal cases focused on what
  // they assert, and a test that cares about the row supplies its own route first.
  const db = fakeDb([...routes, ['INSERT INTO trigger_delivery', { rows: [], rowCount: 1 }]]);
  const audit = { append: vi.fn(async () => undefined), lockChain: vi.fn(async () => undefined) };
  const secrets = {
    put: vi.fn(async () => ({ id: 'secret-ref-1' })),
    open: vi.fn(async () => 'shared-secret'),
  };
  const service = new PostgresTriggerIngressService(db.pool, audit as never, secrets as never);
  return { db, audit, secrets, service };
}

const SECRET = 'shared-secret';

describe('list', () => {
  it('never returns the URL or the secret material', async () => {
    const { service } = setup([
      [
        'FROM trigger_endpoint WHERE instance_id',
        [
          {
            id: 't1',
            instance_id: 'inst-1',
            workflow_id: 'wf-1',
            event_name: 'order.created',
            state: 'active',
            registered_at: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      ],
    ]);

    await expect(service.list('inst-1')).resolves.toEqual([
      {
        id: 't1',
        instanceId: 'inst-1',
        workflowId: 'wf-1',
        eventName: 'order.created',
        state: 'active',
        registeredAt: '2026-01-01T00:00:00.000Z',
        url: null,
        secret: null,
      },
    ]);
  });
});

describe('register', () => {
  it('stores a secret, hashes the token and reveals the URL once', async () => {
    const { db, audit, secrets, service } = setup([
      [
        'INSERT INTO trigger_endpoint',
        [{ id: 't1', registered_at: new Date('2026-01-01T00:00:00Z') }],
      ],
    ]);

    const endpoint = await service.register(
      'inst-1',
      { eventName: 'order.created', workflowId: 'wf-1' },
      'admin',
    );

    expect(endpoint).toMatchObject({
      id: 't1',
      instanceId: 'inst-1',
      workflowId: 'wf-1',
      eventName: 'order.created',
      state: 'active',
      registeredAt: '2026-01-01T00:00:00.000Z',
    });
    expect(endpoint.url).toMatch(/^\/api\/v1\/trigger\/[0-9a-f]{64}$/);
    expect(endpoint.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.put).toHaveBeenCalledWith(
      'instance',
      'inst-1',
      'trigger_order.created',
      endpoint.secret,
    );

    // Only the hash of the token is stored: a leaked table yields no usable URL.
    const stored = db.calls.find((call) => call.sql.includes('INSERT INTO trigger_endpoint'));
    expect(stored?.params[3]).not.toBe(endpoint.url?.split('/').pop());
    expect(stored?.params[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'trigger.endpoint.registered', targetId: 't1' }),
    );
  });

  it('registers an endpoint that is not bound to a workflow', async () => {
    const { db, service } = setup([
      ['INSERT INTO trigger_endpoint', [{ id: 't1', registered_at: new Date() }]],
    ]);

    const endpoint = await service.register('inst-1', { eventName: 'ping' }, 'admin');

    expect(endpoint.workflowId).toBeNull();
    expect(db.calls[0]?.params[1]).toBeNull();
  });

  it('fails when the row is not returned', async () => {
    const { service } = setup([['INSERT INTO trigger_endpoint', []]]);
    await expect(service.register('inst-1', { eventName: 'ping' }, 'admin')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});

describe('remove', () => {
  it('removes and audits a known endpoint', async () => {
    const { audit, service } = setup([['DELETE FROM trigger_endpoint', { rows: [], rowCount: 1 }]]);

    await service.remove('t1', 'admin');

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'trigger.endpoint.removed', targetId: 't1' }),
    );
  });

  it('refuses an endpoint that is already gone', async () => {
    const { service } = setup([['DELETE FROM trigger_endpoint', { rows: [], rowCount: 0 }]]);
    await expect(service.remove('t1', 'admin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('accept', () => {
  const BODY = Buffer.from('{"order":1}', 'utf8');
  const SIGNATURE = createHmac('sha256', SECRET).update(BODY).digest('hex');

  const ENDPOINT = {
    id: 't1',
    hmac_secret_ref: 'secret-ref-1',
    instance_id: 'inst-1',
    state: 'active',
  };

  function acceptInput(overrides: Record<string, unknown> = {}) {
    return {
      endpointToken: 'path-token',
      rawBody: BODY,
      signature: SIGNATURE,
      deliveryId: 'delivery-1',
      ...overrides,
    } as never;
  }

  it('accepts a correctly signed delivery and audits it', async () => {
    const { db, audit, service } = setup([
      ['FROM trigger_endpoint WHERE token_hash', [ENDPOINT]],
      ['INSERT INTO trigger_delivery', { rows: [{ id: 'd1' }], rowCount: 1 }],
    ]);

    await expect(service.accept(acceptInput())).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });

    const record = db.calls.find((call) => call.sql.includes("VALUES ($1, $2, 'accepted')"));
    expect(record?.params).toEqual(['t1', 'delivery-1']);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'trigger.delivery.accepted',
        detail: { deliveryId: 'delivery-1' },
      }),
    );
  });

  it('derives the delivery id from the body when the sender supplies none', async () => {
    const { db, service } = setup([
      ['FROM trigger_endpoint WHERE token_hash', [ENDPOINT]],
      ['INSERT INTO trigger_delivery', { rows: [{ id: 'd1' }], rowCount: 1 }],
    ]);

    await service.accept(acceptInput({ deliveryId: null }));

    const record = db.calls.find((call) => call.sql.includes("VALUES ($1, $2, 'accepted')"));
    expect(record?.params[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an unknown token without recording a delivery, but still audits', async () => {
    const { db, audit, service } = setup([['FROM trigger_endpoint WHERE token_hash', []]]);

    await expect(service.accept(acceptInput())).resolves.toEqual({
      accepted: false,
      reason: 'unknown endpoint',
    });

    expect(db.calls.some((call) => call.sql.includes('INSERT INTO trigger_delivery'))).toBe(false);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'trigger.rejected',
        targetId: 'unknown',
        outcome: 'denied',
      }),
    );
  });

  it('refuses an endpoint that is not active', async () => {
    const { service } = setup([
      ['FROM trigger_endpoint WHERE token_hash', [{ ...ENDPOINT, state: 'disabled' }]],
    ]);
    await expect(service.accept(acceptInput())).resolves.toMatchObject({
      reason: 'unknown endpoint',
    });
  });

  it('refuses a delivery with no signature and records it against the endpoint', async () => {
    const { db, service } = setup([['FROM trigger_endpoint WHERE token_hash', [ENDPOINT]]]);

    await expect(service.accept(acceptInput({ signature: null }))).resolves.toEqual({
      accepted: false,
      reason: 'missing signature',
    });

    const rejected = db.calls.find((call) => call.sql.includes("'rejected'"));
    expect(rejected?.params[0]).toBe('t1');
    expect(String(rejected?.params[1])).toContain('delivery-1');
  });

  it('refuses a signature mismatch', async () => {
    const { db, service } = setup([['FROM trigger_endpoint WHERE token_hash', [ENDPOINT]]]);

    await expect(service.accept(acceptInput({ signature: 'wrong' }))).resolves.toEqual({
      accepted: false,
      reason: 'signature mismatch',
    });

    // The length guard short-circuits before the constant-time compare.
    expect(db.calls.some((call) => call.sql.includes("'rejected'"))).toBe(true);
  });

  it('records a duplicate delivery once and refuses the second attempt', async () => {
    const { db, service } = setup([
      ['FROM trigger_endpoint WHERE token_hash', [ENDPOINT]],
      ['INSERT INTO trigger_delivery', { rows: [], rowCount: 0 }],
    ]);

    await expect(service.accept(acceptInput())).resolves.toEqual({
      accepted: false,
      reason: 'duplicate delivery',
    });

    const duplicate = db.calls.find((call) => call.sql.includes("'duplicate'"));
    expect(duplicate?.params[1]).toContain('delivery-1:duplicate:');
  });

  it('uses an anonymous key when a rejected delivery carries no id', async () => {
    const { db, service } = setup([['FROM trigger_endpoint WHERE token_hash', [ENDPOINT]]]);

    await service.accept(acceptInput({ signature: null, deliveryId: null }));

    const rejected = db.calls.find((call) => call.sql.includes("'rejected'"));
    expect(String(rejected?.params[1])).toContain('anonymous:');
  });
});
