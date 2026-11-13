import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { generateRootKey } from '../../../../src/modules/m15-secrets/envelope';
import { EnvelopeSecretsService } from '../../../../src/modules/m15-secrets/secrets.service';

/**
 * The version numbers a secret can have before it has any. `MAX(version)` over an empty
 * `secret_version` is `NULL`, and both readers of that aggregate have to answer with the number the
 * next write will actually use — `1` for a write, `0` for a metadata read of a secret whose value
 * was never stored. Reporting `null` there is a contract violation, not an absence.
 */
const h = vi.hoisted(() => ({ withTransaction: vi.fn() }));
vi.mock('@seamnex/db', () => ({ withTransaction: h.withTransaction }));

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'seamnex-secret-'));
  dirs.push(dir);
  const path = join(dir, 'root.key');
  writeFileSync(path, generateRootKey(), 'utf8');

  const db = fakeDb(routes);
  h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
    fn(db.client),
  );
  const audit = { lockChain: vi.fn(async () => undefined), append: vi.fn(async () => undefined) };
  const metrics = { secretsDecrypted: { labels: vi.fn(() => ({ inc: vi.fn() })) } };
  const config = {
    SEAMNEX_ROOT_KEY_FILE: path,
    SEAMNEX_ROOT_KEY_STRICT_MODE: false,
    SEAMNEX_ROLE: 'api',
  } as unknown as AppConfig;

  return {
    db,
    audit,
    service: new EnvelopeSecretsService(db.pool, config, audit as never, metrics as never),
  };
}

beforeEach(() => {
  h.withTransaction.mockReset();
});

describe('find', () => {
  it('reports version 0 for a secret whose value was never written', async () => {
    const { service } = setup([
      [
        'FROM secret s',
        [{ id: 'secret-1', scope: 'workflow', owner_id: 'wf-1', name: 'api-key', version: null }],
      ],
    ]);

    await expect(service.find('workflow', 'wf-1', 'api-key')).resolves.toEqual({
      id: 'secret-1',
      scope: 'workflow',
      ownerId: 'wf-1',
      name: 'api-key',
      version: 0,
      masked: '********',
    });
  });
});

describe('put', () => {
  it('numbers the first version 1 when the version aggregate returns no row', async () => {
    const { audit, db, service } = setup([
      ['INSERT INTO secret (', [{ id: 'secret-1' }]],
      ['SELECT COALESCE(MAX(version)', []],
      ['INSERT INTO secret_version', []],
    ]);

    const metadata = await service.put('workflow', 'wf-1', 'api-key', 'hunter2');

    expect(metadata.version).toBe(1);
    const version = db.calls.find((call) => call.sql.includes('INSERT INTO secret_version'));
    // The written row is version 1, and the audited detail says so: the two cannot disagree.
    expect(version?.params[1]).toBe(1);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ version: 1 }) }),
      expect.anything(),
    );
  });
});

/**
 * The refusal path is the one place a caller learns that its `secret_ref` drifted, and the denial
 * itself is written on a separate connection because the throw rolls the transaction back. An audit
 * chain that is also down must not change the answer: the caller still cannot reach the value.
 */
describe('scope refusals', () => {
  it('refuses to open a secret owned by another scope, even with the chain down', async () => {
    const { audit, service } = setup([
      [
        'FROM secret_version v',
        [
          {
            secret_id: 'secret-1',
            version: 1,
            scope: 'workflow',
            owner_id: 'wf-1',
            name: 'api-key',
          },
        ],
      ],
    ]);
    audit.append.mockRejectedValueOnce(new Error('audit chain unavailable'));

    await expect(
      service.open('secret-1', 'relay provisioning', {
        scope: 'product_account',
        ownerId: 'acc-1',
      }),
    ).rejects.toThrow('No such secret');
  });

  it('refuses to delete a secret owned by another scope, even with the chain down', async () => {
    const { audit, service } = setup([
      [
        'SELECT scope, owner_id, name FROM secret WHERE id = $1 FOR UPDATE',
        [{ scope: 'workflow', owner_id: 'wf-1', name: 'api-key' }],
      ],
    ]);
    audit.append.mockRejectedValueOnce(new Error('audit chain unavailable'));

    await expect(
      service.remove('secret-1', 'offboarding subject-1', {
        scope: 'product_account',
        ownerId: 'acc-1',
      }),
    ).rejects.toThrow('No such secret');
  });

  it('records the row it read when the delete returns nothing', async () => {
    const { audit, service, db } = setup([
      [
        'SELECT scope, owner_id, name FROM secret WHERE id = $1 FOR UPDATE',
        [{ scope: 'workflow', owner_id: 'wf-1', name: 'api-key' }],
      ],
      ['DELETE FROM secret WHERE id = $1 RETURNING', []],
    ]);

    await service.remove('secret-1', 'offboarding subject-1');

    // A concurrent pass deleted the row between the read and the write; the audit row still names
    // what was removed rather than leaving the fields blank.
    expect(db.calls.some((call) => call.sql.startsWith('DELETE FROM secret'))).toBe(true);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'secret.delete',
        detail: expect.objectContaining({ scope: 'workflow', name: 'api-key' }),
      }),
      expect.anything(),
    );
  });
});
