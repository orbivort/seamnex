import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { resolveEgressInstance } from '../../../../src/modules/m13-workflow/egress-instance';
import { fakeDb } from '../../../support/fakes';

/**
 * The `422` side of egress resolution: a node whose product has no usable deployment cannot run, and
 * the refusal has to name which of the two causes applies — nothing deployed, or a deployment that
 * cannot issue the credential the node needs (C-11). Which deployment wins is pinned in
 * `@seamnex/domain` (`selectEgressInstance`), because authorization asks the same question.
 */

const INSTANCE_ROWS = 'FROM instance i WHERE i.entry_key';

describe('resolveEgressInstance', () => {
  it('answers the winning instance id', async () => {
    const db = fakeDb([
      [
        INSTANCE_ROWS,
        [
          { id: 'a', granularity: 'account' },
          { id: 'b', granularity: 'scoped' },
        ],
      ],
    ]);

    await expect(
      resolveEgressInstance(db.pool as unknown as Pool, 'D01-01', 'write'),
    ).resolves.toBe('b');
  });

  it('refuses a product that is not deployed here, naming the entry key', async () => {
    const db = fakeDb([[INSTANCE_ROWS, []]]);

    await expect(
      resolveEgressInstance(db.pool as unknown as Pool, 'D99-99', 'write'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'No deployed D99-99 instance to run this node against.',
    });
  });

  it('refuses a write target whose deployment cannot mint an operation scope', async () => {
    const db = fakeDb([[INSTANCE_ROWS, [{ id: 'a', granularity: 'account' }]]]);

    await expect(
      resolveEgressInstance(db.pool as unknown as Pool, 'D01-01', 'write'),
    ).rejects.toMatchObject({
      detail: expect.stringContaining('operation-scoped credential'),
      remediation: expect.stringContaining('read-only'),
    });
  });

  it('refuses a read from a deployment the platform cannot authenticate against', async () => {
    const db = fakeDb([[INSTANCE_ROWS, [{ id: 'a', granularity: 'none' }]]]);

    await expect(
      resolveEgressInstance(db.pool as unknown as Pool, 'D01-01', 'read'),
    ).rejects.toMatchObject({
      detail: expect.stringContaining('credential the platform can broker'),
    });
  });
});
