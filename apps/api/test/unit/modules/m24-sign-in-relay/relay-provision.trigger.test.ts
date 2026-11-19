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
    deferredUntil: vi.fn(async (): Promise<string | null> => null),
    deprovision: vi.fn(async () => undefined),
  };
  const trigger = new RelayProvisionTrigger(outbox as never, accounts as never);
  trigger.onModuleInit();
  return { trigger, outbox, accounts, handlers };
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

  /*
   * The deployment asks the moment it records its route. OpenProject is still booting then, so the
   * pass is deferred — and before this the event was simply dropped, leaving a fresh install on the
   * product's own login form until the next five-minute sweep.
   */
  it('re-runs the pass when the bootstrap window opens instead of waiting for the sweep', async () => {
    vi.useFakeTimers();
    try {
      const { accounts, handlers } = build();
      accounts.deferredUntil
        .mockResolvedValueOnce(new Date(Date.now() + 60_000).toISOString())
        .mockResolvedValue(null);

      await handlers.get('relay.provision')?.(row(INSTANCE));
      expect(accounts.provisionInstance).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(61_000);

      expect(accounts.provisionInstance).toHaveBeenCalledTimes(2);
      expect(accounts.deferredUntil).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a refused credential to the sweep instead of holding a timer for hours', async () => {
    vi.useFakeTimers();
    try {
      const { accounts, handlers } = build();
      accounts.deferredUntil.mockResolvedValue(
        new Date(Date.now() + 6 * 60 * 60 * 1_000).toISOString(),
      );

      await handlers.get('relay.provision')?.(row(INSTANCE));
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);

      expect(accounts.provisionInstance).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after a bounded number of windows rather than becoming a retry loop', async () => {
    vi.useFakeTimers();
    try {
      const { accounts, handlers } = build();
      accounts.deferredUntil.mockImplementation(async () =>
        new Date(Date.now() + 60_000).toISOString(),
      );

      await handlers.get('relay.provision')?.(row(INSTANCE));
      for (let tick = 0; tick < 6; tick += 1) await vi.advanceTimersByTimeAsync(61_000);

      // The first pass plus three re-runs; the sweep owns everything after that.
      expect(accounts.provisionInstance).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues one re-run per instance when events arrive together', async () => {
    vi.useFakeTimers();
    try {
      const { accounts, handlers } = build();
      const handler = handlers.get('relay.provision');
      accounts.deferredUntil
        .mockResolvedValueOnce(new Date(Date.now() + 60_000).toISOString())
        .mockResolvedValueOnce(new Date(Date.now() + 60_000).toISOString())
        .mockResolvedValue(null);

      await handler?.(row(INSTANCE));
      await handler?.(row(INSTANCE));
      expect(accounts.provisionInstance).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(61_000);

      // One queued re-run, not one per event: a stacked timer would make this four.
      expect(accounts.provisionInstance).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * A window that cannot be read is not a reason to fail the event: the sweep is the fallback the
   * caller had before, so the read costs nothing beyond the delay it already had.
   */
  it('leaves the retry to the sweep when the window cannot be read', async () => {
    const { accounts, handlers } = build();
    accounts.deferredUntil.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(handlers.get('relay.provision')?.(row(INSTANCE))).resolves.toBeUndefined();
    expect(accounts.provisionInstance).toHaveBeenCalledOnce();
  });

  it('clears a queued re-run on shutdown instead of firing into a stopping container', async () => {
    vi.useFakeTimers();
    try {
      const { trigger, accounts, handlers } = build();
      accounts.deferredUntil.mockResolvedValueOnce(new Date(Date.now() + 60_000).toISOString());

      await handlers.get('relay.provision')?.(row(INSTANCE));
      expect(accounts.provisionInstance).toHaveBeenCalledTimes(1);

      trigger.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(61_000);

      // The timer was the only thing left holding the pass; shutting down drops it.
      expect(accounts.provisionInstance).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
