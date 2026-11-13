import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { FieldSnapshotRow } from '@seamnex/db';
import type { FieldDiscoveryResult } from '../../../../src/modules/m25-workflow-egress/egress.contract';
import { FieldDiscoveryService } from '../../../../src/modules/m13-workflow/field-discovery.service';

/**
 * FR-5.5 — discovery is cache-first, and every branch of the cache is a product-protection rule: a
 * schema is trusted for a day, an explicit refresh cannot repeat inside a minute, and a product that
 * did not answer is left alone for five.
 */
const INSTANCE = '1a2b3c4d-0000-4000-8000-000000000001';
const TARGET = { instanceId: INSTANCE, entryKey: 'D01-01', operation: 'contacts.write' };

function row(over: Partial<FieldSnapshotRow> = {}): FieldSnapshotRow {
  return {
    id: 'snap-1',
    instance_id: INSTANCE,
    entry_key: 'D01-01',
    operation: 'contacts.write',
    status: 'available',
    fields: [{ name: 'emailAddress', label: null, type: 'string', required: true }],
    detail: null,
    fetched_at: new Date(),
    retry_after: null,
    ...over,
  };
}

function harness(existing: FieldSnapshotRow | null) {
  const repo = {
    get: vi.fn(async () => existing),
    forKeys: vi.fn(async () => new Map()),
    upsert: vi.fn(async (input: { status: string }) =>
      row({ status: input.status as 'available' }),
    ),
  };
  const egress = {
    forward: vi.fn(),
    discoverFields: vi.fn(async (): Promise<FieldDiscoveryResult> => ({
      status: 'available',
      fields: [{ name: 'emailAddress', label: 'Email', type: 'string', required: true }],
    })),
  };
  const audit = { append: vi.fn(async () => ({ seq: '1', hash: 'h' })) };
  const config = { SEAMNEX_FIELD_DISCOVERY_TTL_MS: 24 * 60 * 60 * 1_000 };
  const service = new FieldDiscoveryService(
    config as never,
    audit as never,
    egress as never,
    repo as never,
  );
  return { service, repo, egress, audit };
}

describe('FieldDiscoveryService', () => {
  /*
   * The validation pass asks for every mapped target at once. Twelve nodes must cost one indexed
   * lookup, not twelve round trips on the authoring screen.
   */
  it('reads the cached snapshots for a whole definition in one query', async () => {
    const { service, repo } = harness(null);
    const targets = [
      { instanceId: INSTANCE, operation: 'contacts.write' },
      { instanceId: INSTANCE, operation: 'contacts.read' },
    ];

    const rows = await service.cached(targets);

    expect(repo.forKeys).toHaveBeenCalledOnce();
    expect(repo.forKeys).toHaveBeenCalledWith(targets);
    expect(rows).toEqual(new Map());
  });

  it('serves a fresh snapshot without touching the product', async () => {
    const { service, egress } = harness(row());

    const result = await service.snapshot(TARGET, { refresh: false, actorId: 'actor' });

    expect(result.status).toBe('available');
    expect(egress.discoverFields).not.toHaveBeenCalled();
  });

  it('reads the product once the snapshot outlives the TTL', async () => {
    const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    const { service, egress, repo } = harness(row({ fetched_at: stale }));

    await service.snapshot(TARGET, { refresh: false, actorId: 'actor' });

    expect(egress.discoverFields).toHaveBeenCalledWith(TARGET);
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: INSTANCE, operation: 'contacts.write' }),
    );
  });

  it('refuses a second refresh inside the floor, even when asked explicitly', async () => {
    const justNow = new Date(Date.now() - 10_000);
    const { service, egress } = harness(row({ fetched_at: justNow }));

    await service.snapshot(TARGET, { refresh: true, actorId: 'actor' });

    expect(egress.discoverFields).not.toHaveBeenCalled();
  });

  it('records an unavailable product with a backoff instead of failing the caller', async () => {
    const { service, egress, repo, audit } = harness(null);
    egress.discoverFields.mockResolvedValueOnce({
      status: 'unavailable',
      detail: 'D01-01 answered 503 when asked for its field schema.',
    });

    const result = await service.snapshot(TARGET, { refresh: false, actorId: 'actor' });

    expect(result.status).toBe('unavailable');
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'unavailable',
        detail: 'D01-01 answered 503 when asked for its field schema.',
        retryAfter: expect.any(Date),
      }),
    );
    // The audit says what was asked and what came back — never the schema itself.
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.fields.discovered',
        outcome: 'failure',
        detail: expect.objectContaining({ status: 'unavailable', fieldCount: 0 }),
      }),
    );
  });

  it('does not dial a product that is still inside its failure backoff', async () => {
    const { service, egress } = harness(
      row({
        status: 'unavailable',
        fields: [],
        fetched_at: new Date(Date.now() - 5 * 60 * 60 * 1_000),
        retry_after: new Date(Date.now() + 60_000),
      }),
    );

    const result = await service.snapshot(TARGET, { refresh: true, actorId: 'actor' });

    expect(result.status).toBe('unavailable');
    expect(egress.discoverFields).not.toHaveBeenCalled();
  });

  it('stores an unavailable snapshot when the egress service throws instead of answering', async () => {
    const { service, egress, repo } = harness(null);
    egress.discoverFields.mockRejectedValueOnce(new Error('the broker is not running'));

    const result = await service.snapshot(TARGET, { refresh: false, actorId: 'actor' });

    expect(result.status).toBe('unavailable');
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'unavailable',
        detail: 'The product schema could not be read: the broker is not running',
      }),
    );
  });

  it('answers the drawer even when the audit chain refuses the discovery row', async () => {
    const { service, audit, repo } = harness(null);
    audit.append.mockRejectedValueOnce(new Error('audit unavailable'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const result = await service.snapshot(TARGET, { refresh: false, actorId: 'actor' });

    expect(result.status).toBe('available');
    expect(repo.upsert).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('field discovery audit failed'));
    warn.mockRestore();
  });

  it('shares one in-flight read between two callers of the same key', async () => {
    const { service, egress } = harness(null);
    egress.discoverFields.mockImplementation(
      async () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                status: 'available' as const,
                fields: [
                  { name: 'emailAddress', label: null, type: 'string' as const, required: true },
                ],
              }),
            5,
          );
        }),
    );

    await Promise.all([
      service.snapshot(TARGET, { refresh: false, actorId: 'actor' }),
      service.snapshot(TARGET, { refresh: false, actorId: 'actor' }),
    ]);

    expect(egress.discoverFields).toHaveBeenCalledTimes(1);
  });
});
