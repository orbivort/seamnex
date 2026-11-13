import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { OutboxRow } from '@seamnex/db';
import { RelayProvisionTrigger } from '../../../../src/modules/m24-sign-in-relay/relay-provision.trigger';

/**
 * The deployment-complete trigger.
 *
 * The property under test is not "provisioning works" — the sweep's own suite owns that — but that
 * the event turns into exactly one targeted pass, that a malformed event is refused instead of
 * reaching PostgreSQL as `22P02`, and that a failure here cannot become the outbox's five retries
 * against a product's administrator credential.
 */

const INSTANCE = '11111111-1111-4111-8111-111111111111';

function build() {
  const handlers = new Map<string, (row: OutboxRow) => Promise<void>>();
  const outbox = {
    on: vi.fn((eventType: string, handler: (row: OutboxRow) => Promise<void>) => {
      handlers.set(eventType, handler);
    }),
    emit: vi.fn(),
    claim: vi.fn(),
    dispatchBatch: vi.fn(),
  };
  const accounts = {
    sweep: vi.fn(async () => undefined),
    provisionInstance: vi.fn(async () => undefined),
    deprovision: vi.fn(async () => undefined),
  };
  const trigger = new RelayProvisionTrigger(outbox as never, accounts as never);
  trigger.onModuleInit();
  return { outbox, accounts, handlers };
}

function row(aggregateId: string): OutboxRow {
  return {
    id: '1',
    aggregate_type: 'instance',
    aggregate_id: aggregateId,
    event_type: 'relay.provision',
    payload: { reason: 'deployment-complete' },
    created_at: new Date(),
    claimed_at: null,
    dispatched_at: null,
    attempts: 1,
    last_error: null,
  };
}

describe('RelayProvisionTrigger', () => {
  it('subscribes to the deployment event', () => {
    const { outbox } = build();

    expect(outbox.on).toHaveBeenCalledWith('relay.provision', expect.any(Function));
  });

  it('provisions the instance the deployment named', async () => {
    const { accounts, handlers } = build();

    await handlers.get('relay.provision')?.(row(INSTANCE));

    // No subject: the deployment made every entitled person eligible, not one of them.
    expect(accounts.provisionInstance).toHaveBeenCalledWith(INSTANCE);
  });

  it('refuses an aggregate id that is not an instance id', async () => {
    const { accounts, handlers } = build();

    await expect(handlers.get('relay.provision')?.(row('all'))).resolves.toBeUndefined();
    expect(accounts.provisionInstance).not.toHaveBeenCalled();
  });

  it('does not let a failed pass become the outbox retrying the product', async () => {
    const { accounts, handlers } = build();
    accounts.provisionInstance.mockRejectedValueOnce(new Error('database unavailable'));

    // The sweep owns the retry policy, so the event is dispatched even when the pass failed.
    await expect(handlers.get('relay.provision')?.(row(INSTANCE))).resolves.toBeUndefined();
  });

  it('logs a refusal that is not an Error as the value it was', async () => {
    const { accounts, handlers } = build();
    accounts.provisionInstance.mockRejectedValueOnce('the product refused the bootstrap');
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(handlers.get('relay.provision')?.(row(INSTANCE))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('the product refused the bootstrap'),
    );
    error.mockRestore();
  });
});
