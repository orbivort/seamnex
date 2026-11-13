import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import {
  aadFor,
  generateRootKey,
  loadRootKey,
  seal,
} from '../../../../src/modules/m15-secrets/envelope';
import { EnvelopeSecretsService } from '../../../../src/modules/m15-secrets/secrets.service';

/**
 * The secret store is where "mask by default" has to be true rather than aspirational: no method
 * returns a value except `open`, and `open` writes `secret.read` before the plaintext escapes. The
 * rows here are sealed with the real envelope under a real root key file, so the decryption paths
 * (including a corrupted ciphertext, which must be audited even though the transaction rolls back)
 * are exercised for real rather than stubbed.
 */
const h = vi.hoisted(() => ({ withTransaction: vi.fn() }));
vi.mock('@seamnex/db', () => ({ withTransaction: h.withTransaction }));

const dirs: string[] = [];

function rootKeyFile(): { path: string; rootKey: ReturnType<typeof loadRootKey> } {
  const dir = mkdtempSync(join(tmpdir(), 'seamnex-secret-'));
  dirs.push(dir);
  const path = join(dir, 'root.key');
  writeFileSync(path, generateRootKey(), 'utf8');
  return { path, rootKey: loadRootKey(path, { strictMode: false }) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const { path, rootKey } = rootKeyFile();
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
  const service = new EnvelopeSecretsService(db.pool, config, audit as never, metrics as never);
  return { db, audit, metrics, service, rootKey };
}

/** A row shaped like `secret_version`, sealed under the setup's root key. */
function sealedRow(secretId: string, version: number, value = 'hunter2'): Record<string, unknown> {
  return { secretId, version, value };
}

function rowFor(sealed: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'sv-1',
    secret_id: sealed.secretId,
    version: sealed.version,
    dek_id: 'dek-1',
    dek_wrapped: sealed.dekWrapped,
    ciphertext: sealed.ciphertext,
    aad: 'not-read-back',
    rotated_at: null,
    created_by: 'api',
  };
}

beforeEach(() => {
  h.withTransaction.mockReset();
});

describe('put', () => {
  it('seals the value, writes the version and audits inside one transaction', async () => {
    const { db, audit, service } = setup([
      ['INSERT INTO secret (', [{ id: 'secret-1' }]],
      ['SELECT COALESCE(MAX(version)', [{ next: 3 }]],
      ['INSERT INTO secret_version', []],
    ]);

    const metadata = await service.put('workflow', 'wf-1', 'api-key', 'hunter2');

    expect(metadata).toEqual({
      id: 'secret-1',
      scope: 'workflow',
      ownerId: 'wf-1',
      name: 'api-key',
      version: 3,
      masked: '********',
    });
    expect(audit.lockChain).toHaveBeenCalledOnce();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'secret.write',
        actorId: 'api',
        detail: { scope: 'workflow', ownerId: 'wf-1', name: 'api-key', version: 3 },
      }),
      expect.anything(),
    );

    const version = db.calls.find((call) => call.sql.includes('INSERT INTO secret_version'));
    // The ciphertext must not be the plaintext.
    expect(String(version?.params[4])).not.toContain('hunter2');
    expect(version?.params).toHaveLength(7);
  });

  it('joins the caller transaction without taking the chain lock twice', async () => {
    // The caller already holds the lock; taking it again on a second connection would deadlock
    // against this very request.
    const { db, audit, service, rootKey } = setup([
      ['INSERT INTO secret (', [{ id: 'secret-1' }]],
      ['SELECT COALESCE(MAX(version)', [{ next: 1 }]],
      ['INSERT INTO secret_version', []],
    ]);
    void rootKey;

    const metadata = await service.put('workflow', 'wf-1', 'api-key', 'v', db.client);

    expect(metadata.version).toBe(1);
    expect(audit.lockChain).not.toHaveBeenCalled();
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO secret_version'))).toBe(true);
  });

  it('defaults the version to 1 when the version query returns nothing', async () => {
    const { service } = setup([
      ['INSERT INTO secret (', [{ id: 'secret-1' }]],
      ['SELECT COALESCE(MAX(version)', []],
      ['INSERT INTO secret_version', []],
    ]);

    await expect(service.put('workflow', 'wf-1', 'k', 'v')).resolves.toMatchObject({ version: 1 });
  });

  it('fails when the secret row is not returned', async () => {
    const { service } = setup([['INSERT INTO secret (', []]]);
    await expect(service.put('workflow', 'wf-1', 'k', 'v')).rejects.toThrow(
      'secret upsert returned no row',
    );
  });
});

describe('rotate', () => {
  it('appends a new version and audits the rotation', async () => {
    const { db, audit, service } = setup([
      [
        'FROM secret WHERE id = $1 FOR UPDATE',
        [{ scope: 'instance', owner_id: 'inst-1', name: 'db' }],
      ],
      ['SELECT COALESCE(MAX(version)', [{ next: 4 }]],
      ['INSERT INTO secret_version', []],
    ]);

    const metadata = await service.rotate('secret-1', 'new-value');

    expect(metadata).toEqual({
      id: 'secret-1',
      scope: 'instance',
      ownerId: 'inst-1',
      name: 'db',
      version: 4,
      masked: '********',
    });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'secret.rotate',
        detail: { scope: 'instance', name: 'db', version: 4 },
      }),
      expect.anything(),
    );
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO secret_version'))).toBe(true);
  });

  it('refuses to rotate a secret that does not exist', async () => {
    const { service } = setup([['FROM secret WHERE id = $1 FOR UPDATE', []]]);
    await expect(service.rotate('missing', 'v')).rejects.toMatchObject({
      code: 'SECRET_NOT_FOUND',
      status: 404,
    });
  });

  it('joins the caller transaction without re-locking the chain', async () => {
    const { db, audit, service } = setup([
      ['FROM secret WHERE id = $1 FOR UPDATE', [{ scope: 'instance', owner_id: 'i', name: 'n' }]],
      ['SELECT COALESCE(MAX(version)', [{ next: 2 }]],
      ['INSERT INTO secret_version', []],
    ]);

    await service.rotate('secret-1', 'v', undefined, db.client);

    expect(audit.lockChain).not.toHaveBeenCalled();
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO secret_version'))).toBe(true);
  });

  /*
   * Rotation *replaces* the value, so an id that drifted onto another scope's secret would overwrite
   * it — the instance admin token, another mapping's password — and audit the rotation as a success.
   */
  it('refuses a rotation aimed at another owner and audits the refusal', async () => {
    const { db, audit, service } = setup([
      [
        'FROM secret WHERE id = $1 FOR UPDATE',
        [{ scope: 'instance', owner_id: 'instance-1', name: 'product_api_token' }],
      ],
    ]);

    await expect(
      service.rotate('secret-1', 'new-value', { scope: 'product_account', ownerId: 'account-1' }),
    ).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });

    expect(db.calls.some((call) => call.sql.includes('INSERT INTO secret_version'))).toBe(false);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'secret.rotate',
        outcome: 'failure',
        detail: expect.objectContaining({ error: 'SCOPE_MISMATCH' }),
      }),
    );
  });

  it('rotates when the caller names the owner the secret is filed under', async () => {
    const { service } = setup([
      [
        'FROM secret WHERE id = $1 FOR UPDATE',
        [{ scope: 'product_account', owner_id: 'account-1', name: 'password' }],
      ],
      ['SELECT COALESCE(MAX(version)', [{ next: 2 }]],
      ['INSERT INTO secret_version', []],
    ]);

    await expect(
      service.rotate('secret-1', 'new-value', { scope: 'product_account', ownerId: 'account-1' }),
    ).resolves.toMatchObject({ ownerId: 'account-1', version: 2 });
  });
});

describe('remove', () => {
  it('deletes the secret and audits the deletion', async () => {
    const { db, audit, service } = setup([
      [
        'FROM secret WHERE id = $1 FOR UPDATE',
        [{ scope: 'product_account', owner_id: 'account-1', name: 'password' }],
      ],
      [
        'DELETE FROM secret WHERE id = $1',
        [{ scope: 'product_account', owner_id: 'account-1', name: 'password' }],
      ],
    ]);

    await service.remove('secret-1', 'offboarding subject-1', {
      scope: 'product_account',
      ownerId: 'account-1',
    });

    expect(db.calls.some((call) => call.sql.includes('DELETE FROM secret WHERE id = $1'))).toBe(
      true,
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'secret.delete', outcome: 'success' }),
      expect.anything(),
    );
  });

  /*
   * Offboarding is the destructive path: without the assertion a drifted `secret_ref` would make it
   * delete an unrelated secret, so the refusal has to happen before the write and leave a trace.
   */
  it('refuses to delete another owner’s secret and deletes nothing', async () => {
    const { db, audit, service } = setup([
      [
        'FROM secret WHERE id = $1 FOR UPDATE',
        [{ scope: 'instance', owner_id: 'instance-1', name: 'product_api_token' }],
      ],
    ]);

    await expect(
      service.remove('secret-1', 'offboarding subject-1', {
        scope: 'product_account',
        ownerId: 'account-1',
      }),
    ).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });

    expect(db.calls.some((call) => call.sql.includes('DELETE FROM secret'))).toBe(false);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'secret.delete',
        outcome: 'failure',
        detail: expect.objectContaining({ error: 'SCOPE_MISMATCH' }),
      }),
    );
  });

  it('is a no-op for an id that is already gone, so offboarding can be retried', async () => {
    const { service } = setup([['FROM secret WHERE id = $1 FOR UPDATE', []]]);

    await expect(service.remove('missing', 'offboarding subject-1')).resolves.toBeUndefined();
  });
});

describe('open', () => {
  function row(id: string, version: number, rootKey: ReturnType<typeof loadRootKey>) {
    const sealed = seal(Buffer.from('the-plaintext', 'utf8'), rootKey, aadFor(id, version));
    return rowFor({
      ...sealedRow(id, version),
      dekWrapped: sealed.dekWrapped,
      ciphertext: sealed.ciphertext,
    });
  }

  it('decrypts the newest version, audits the read first and counts the decryption', async () => {
    const { db, audit, metrics, service, rootKey } = setup();

    const put = fakeDb([['FROM secret_version', [row('secret-1', 2, rootKey)]]]);
    h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
      fn(put.client),
    );

    await expect(service.open('secret-1', 'workflow run')).resolves.toBe('the-plaintext');

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'secret.read',
        outcome: 'success',
        detail: { reason: 'workflow run', version: 2 },
      }),
      expect.anything(),
    );
    expect(metrics.secretsDecrypted.labels).toHaveBeenCalledWith('managed');
    expect(db.calls).toEqual([]);
  });

  /*
   * The scope is an authorization claim, not a naming convention: without this check any caller
   * holding an id could decrypt any other scope's value, including a per-user product password
   * (ADR-BE-22).
   */
  it('refuses a secret filed under another owner and audits the refusal', async () => {
    const { audit, service, rootKey } = setup();
    const conflicting = {
      ...row('secret-1', 1, rootKey),
      scope: 'instance',
      owner_id: 'instance-1',
    };
    h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
      fn(fakeDb([['FROM secret_version', [conflicting]]]).client),
    );

    await expect(
      service.open('secret-1', 'relay sign-in', {
        scope: 'product_account',
        ownerId: 'account-1',
      }),
    ).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });

    // Refused before decryption, and the refusal is a row an operator can see.
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'secret.read',
        outcome: 'failure',
        detail: expect.objectContaining({ error: 'SCOPE_MISMATCH' }),
      }),
    );
  });

  it('opens when the caller names the scope and owner the secret is filed under', async () => {
    const { service, rootKey } = setup();
    const matching = {
      ...row('secret-1', 2, rootKey),
      scope: 'product_account',
      owner_id: 'account-1',
    };
    h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
      fn(fakeDb([['FROM secret_version', [matching]]]).client),
    );

    await expect(
      service.open('secret-1', 'relay sign-in', {
        scope: 'product_account',
        ownerId: 'account-1',
      }),
    ).resolves.toBe('the-plaintext');
  });

  it('refuses a secret with no stored version', async () => {
    const { service } = setup();
    h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
      fn(fakeDb([['FROM secret_version', []]]).client),
    );

    await expect(service.open('missing', 'reason')).rejects.toMatchObject({
      code: 'SECRET_NOT_FOUND',
    });
  });

  it('audits a failed decrypt outside the transaction and rethrows', async () => {
    const { audit, service } = setup();
    const broken = {
      id: 'sv-1',
      secret_id: 'secret-1',
      version: 1,
      dek_id: 'dek',
      dek_wrapped: Buffer.alloc(60),
      ciphertext: Buffer.alloc(40),
      aad: 'x',
      rotated_at: null,
      created_by: 'api',
    };
    h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
      fn(fakeDb([['FROM secret_version', [broken]]]).client),
    );

    await expect(service.open('secret-1', 'reason')).rejects.toMatchObject({
      code: 'SECRET_UNAVAILABLE',
    });
    // The failure is appended without a transaction handle: the one it was in is rolling back.
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'secret.read',
        outcome: 'failure',
        detail: expect.objectContaining({ error: 'SECRET_UNAVAILABLE' }),
      }),
    );
  });

  it('still fails the read when the failure cannot be audited', async () => {
    const { audit, service } = setup();
    audit.append.mockRejectedValue(new Error('audit down'));
    const broken = {
      id: 'sv-1',
      secret_id: 'secret-1',
      version: 1,
      dek_id: 'dek',
      dek_wrapped: Buffer.alloc(60),
      ciphertext: Buffer.alloc(40),
      aad: 'x',
      rotated_at: null,
      created_by: 'api',
    };
    h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
      fn(fakeDb([['FROM secret_version', [broken]]]).client),
    );

    await expect(service.open('secret-1', 'reason')).rejects.toMatchObject({
      code: 'SECRET_UNAVAILABLE',
    });
  });

  it('refuses the read when the success audit cannot be written', async () => {
    const { audit, service, rootKey } = setup();
    audit.append.mockRejectedValue(new Error('audit down'));
    h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
      fn(fakeDb([['FROM secret_version', [row('secret-1', 1, rootKey)]]]).client),
    );

    await expect(service.open('secret-1', 'reason')).rejects.toThrow('audit down');
  });
});

describe('describe and find', () => {
  it('describes a secret with its newest version', async () => {
    const { service } = setup([
      ['FROM secret s', [{ id: 's1', scope: 'workflow', owner_id: 'wf-1', name: 'k', version: 5 }]],
    ]);

    await expect(service.describe('s1')).resolves.toEqual({
      id: 's1',
      scope: 'workflow',
      ownerId: 'wf-1',
      name: 'k',
      version: 5,
      masked: '********',
    });
  });

  it('reports version 0 for a secret with no version yet', async () => {
    const { service } = setup([
      [
        'FROM secret s',
        [{ id: 's1', scope: 'workflow', owner_id: 'wf-1', name: 'k', version: null }],
      ],
    ]);
    await expect(service.describe('s1')).resolves.toMatchObject({ version: 0 });
  });

  it('refuses to describe a secret that does not exist', async () => {
    const { service } = setup([['FROM secret s', []]]);
    await expect(service.describe('missing')).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });
  });

  it('finds a secret by scope, owner and name', async () => {
    const { db, service } = setup([
      ['FROM secret s', [{ id: 's1', scope: 'instance', owner_id: 'i1', name: 'k', version: 2 }]],
    ]);

    await expect(service.find('instance', 'i1', 'k')).resolves.toMatchObject({
      id: 's1',
      version: 2,
    });
    expect(db.calls[0]?.params).toEqual(['instance', 'i1', 'k']);
  });

  it('returns null for a secret that does not exist', async () => {
    const { service } = setup([['FROM secret s', []]]);
    await expect(service.find('instance', 'i1', 'k')).resolves.toBeNull();
  });
});
