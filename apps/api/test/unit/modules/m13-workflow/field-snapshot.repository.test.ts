import { describe, expect, it, vi } from 'vitest';
import type { FieldSnapshotRow } from '@seamnex/db';
import {
  FieldSnapshotRepository,
  snapshotKey,
} from '../../../../src/modules/m13-workflow/field-snapshot.repository';

/**
 * FR-5.5 — the snapshot is the unit of truth for field discovery, so its three queries are the only
 * thing standing between an authoring screen and a product call on every open.
 *
 * The batch read exists because the validation pass asks for every node's key at once: a workflow
 * with twelve nodes must cost one indexed lookup, not twelve.
 */
const INSTANCE = '1a2b3c4d-0000-4000-8000-000000000001';

function row(over: Partial<FieldSnapshotRow> = {}): FieldSnapshotRow {
  return {
    id: 'snap-1',
    instance_id: INSTANCE,
    entry_key: 'D01-01',
    operation: 'contacts.write',
    status: 'available',
    fields: [{ name: 'emailAddress', label: null, type: 'string', required: true }],
    detail: null,
    fetched_at: new Date('2026-11-01T00:00:00.000Z'),
    retry_after: null,
    ...over,
  };
}

function repository(rows: FieldSnapshotRow[] = []) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows }));
  const repo = new FieldSnapshotRepository({ query } as never);
  return { repo, query };
}

describe('snapshotKey', () => {
  it('names one product schema by instance and operation', () => {
    expect(snapshotKey(INSTANCE, 'contacts.read')).toBe(`${INSTANCE}|contacts.read`);
    // A read and a write of the same collection accept different fields.
    expect(snapshotKey(INSTANCE, 'contacts.read')).not.toBe(
      snapshotKey(INSTANCE, 'contacts.write'),
    );
  });
});

describe('FieldSnapshotRepository', () => {
  it('reads one snapshot by instance and operation', async () => {
    const { repo, query } = repository([row()]);

    const found = await repo.get(INSTANCE, 'contacts.write');

    expect(found).toEqual(row());
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM field_snapshot'), [
      INSTANCE,
      'contacts.write',
    ]);
  });

  it('answers null when the product has never been read', async () => {
    const { repo } = repository([]);

    await expect(repo.get(INSTANCE, 'contacts.write')).resolves.toBeNull();
  });

  it('reads a whole definition in one round trip', async () => {
    const { repo, query } = repository([row(), row({ id: 'snap-2', operation: 'contacts.read' })]);

    const found = await repo.forKeys([
      { instanceId: INSTANCE, operation: 'contacts.write' },
      { instanceId: INSTANCE, operation: 'contacts.read' },
    ]);

    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('unnest'), [
      [INSTANCE, INSTANCE],
      ['contacts.write', 'contacts.read'],
    ]);
    expect(found.get(snapshotKey(INSTANCE, 'contacts.write'))?.id).toBe('snap-1');
    expect(found.get(snapshotKey(INSTANCE, 'contacts.read'))?.id).toBe('snap-2');
  });

  it('does not ask the datastore when there is no key to read', async () => {
    const { repo, query } = repository();

    await expect(repo.forKeys([])).resolves.toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it('writes a snapshot and returns the stored row', async () => {
    const { repo, query } = repository([row()]);
    const fields = [{ name: 'emailAddress', label: null, type: 'string' as const, required: true }];

    const stored = await repo.upsert({
      instanceId: INSTANCE,
      entryKey: 'D01-01',
      operation: 'contacts.write',
      status: 'available',
      fields,
      detail: null,
      retryAfter: null,
    });

    expect(stored).toEqual(row());
    const [sql, values] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('ON CONFLICT (instance_id, operation) DO UPDATE');
    expect(values).toEqual([
      INSTANCE,
      'D01-01',
      'contacts.write',
      'available',
      JSON.stringify(fields),
      null,
      null,
    ]);
  });

  it('fails loudly when the write returned no row', async () => {
    const { repo } = repository([]);

    await expect(
      repo.upsert({
        instanceId: INSTANCE,
        entryKey: 'D01-01',
        operation: 'contacts.write',
        status: 'unavailable',
        fields: [],
        detail: 'D01-01 answered 503 when asked for its field schema.',
        retryAfter: new Date('2026-11-01T00:05:00.000Z'),
      }),
    ).rejects.toThrow('The field snapshot was not written.');
  });
});
