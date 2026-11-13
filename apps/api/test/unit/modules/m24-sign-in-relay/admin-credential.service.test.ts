import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../../src/common/problem/app-error';
import { PostgresAdminCredentialService } from '../../../../src/modules/m24-sign-in-relay/admin-credential.service';
import { fakeDb, type Route } from '../../../support/fakes';

/**
 * ADR-BE-22 §Credentials — the operator surface for the one credential the platform cannot derive.
 *
 * The properties worth pinning, in the order they can go wrong:
 *
 *   * the value is write-only: no response, audit row or log line carries it;
 *   * the write is refused for an entry that provisions with a password or has no adapter at all,
 *     so this cannot become a general secret-writing route;
 *   * the secret is written under the instance scope and the configured name the sweep reads, in
 *     the same transaction as the operator's audit row.
 */

const INSTANCE_ID = '9d445d02-8620-4ad6-9c6f-0bea7da9cb9a';
const TOKEN = 'opapi-0123456789abcdefghijklmnopqrstuv';

function build(options: {
  entryKey?: string;
  live?: boolean;
  kind?: 'bearer' | 'password' | null;
  storedVersion?: number | null;
  auditFailure?: boolean;
  putFailure?: boolean;
}) {
  const entryKey = options.entryKey ?? 'D09-01';
  const db = fakeDb([
    ['SELECT entry_key FROM instance', options.live === false ? [] : [{ entry_key: entryKey }]],
  ] as Route[]);

  const secrets = {
    find: vi.fn(async () =>
      options.storedVersion === null || options.storedVersion === undefined
        ? null
        : {
            id: 'secret-1',
            scope: 'instance' as const,
            ownerId: INSTANCE_ID,
            name: 'product_api_token',
            version: options.storedVersion,
            masked: '••••',
          },
    ),
    put: vi.fn(
      async (_scope: string, _ownerId: string, _name: string, _value: string, _tx?: unknown) => {
        if (options.putFailure === true) throw new Error('secret store unavailable');
        return {
          id: 'secret-1',
          scope: 'instance' as const,
          ownerId: INSTANCE_ID,
          name: 'product_api_token',
          version: 4,
          masked: '••••',
        };
      },
    ),
    open: vi.fn(),
    rotate: vi.fn(),
    remove: vi.fn(),
    describe: vi.fn(),
  };

  const audit = {
    append: vi.fn(async () => {
      if (options.auditFailure === true) throw new Error('audit chain unavailable');
      return { seq: '1', hash: 'h' };
    }),
    lockChain: vi.fn(async () => undefined),
    denied: vi.fn(),
    verify: vi.fn(),
    anchor: vi.fn(),
  };

  const kind = options.kind === undefined ? 'bearer' : options.kind;
  const adapters = {
    for: vi.fn(() =>
      kind === null
        ? null
        : { name: kind === 'bearer' ? 'openproject' : 'orangehrm', credentialKind: kind },
    ),
  };

  const config = { SEAMNEX_RELAY_ADMIN_SECRET_NAME: 'product_api_token' };

  const service = new PostgresAdminCredentialService(
    db.pool,
    config as never,
    secrets as never,
    audit as never,
    adapters as never,
  );

  return { service, db, secrets, audit, adapters };
}

describe('the administrator credential surface', () => {
  it('reports a stored bearer token as configured, with its version and no value', async () => {
    const { service, secrets } = build({ storedVersion: 3 });

    const status = await service.status(INSTANCE_ID);

    expect(status).toEqual({
      kind: 'bearer',
      required: true,
      configured: true,
      name: 'product_api_token',
      version: 3,
    });
    expect(secrets.find).toHaveBeenCalledWith('instance', INSTANCE_ID, 'product_api_token');
  });

  it('reports a bearer entry with no token as not configured', async () => {
    const { service } = build({ storedVersion: null });

    await expect(service.status(INSTANCE_ID)).resolves.toEqual({
      kind: 'bearer',
      required: true,
      configured: false,
      name: 'product_api_token',
      version: null,
    });
  });

  it('does not look for a token on an entry that provisions with a password', async () => {
    const { service, secrets } = build({ entryKey: 'D07-01', kind: 'password' });

    await expect(service.status(INSTANCE_ID)).resolves.toMatchObject({
      kind: 'password',
      required: false,
      configured: false,
    });
    // A stored row under this name would not be read by the sweep, so reporting it would describe
    // a product that does not use it.
    expect(secrets.find).not.toHaveBeenCalled();
  });

  it('answers 404 for an instance that is gone', async () => {
    const { service } = build({ live: false });

    await expect(service.status(INSTANCE_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('stores the token under the instance scope and the name the sweep reads', async () => {
    const { service, secrets, audit } = build({ storedVersion: null });

    const result = await service.store(INSTANCE_ID, TOKEN, { type: 'user', id: 'subject-1' });

    expect(result).toEqual({
      kind: 'bearer',
      required: true,
      configured: true,
      name: 'product_api_token',
      version: 4,
    });
    const [scope, ownerId, name, value, tx] = secrets.put.mock.calls[0] ?? [];
    expect([scope, ownerId, name, value]).toEqual([
      'instance',
      INSTANCE_ID,
      'product_api_token',
      TOKEN,
    ]);
    // The secret write and the operator's audit row share one transaction handle.
    expect(tx).toBeDefined();
    expect(audit.lockChain).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.admin_credential.updated',
        actorType: 'user',
        actorId: 'subject-1',
        targetType: 'instance',
        targetId: INSTANCE_ID,
        outcome: 'success',
      }),
      expect.anything(),
    );
  });

  it('never puts the token in the audit detail', async () => {
    const { service, audit } = build({ storedVersion: null });

    await service.store(INSTANCE_ID, TOKEN, { type: 'user', id: 'subject-1' });

    const serialised = JSON.stringify(audit.append.mock.calls);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).toContain('product_api_token');
  });

  it('trims surrounding whitespace rather than storing it as part of the credential', async () => {
    const { service, secrets } = build({ storedVersion: null });

    await service.store(INSTANCE_ID, `  ${TOKEN}\n`, { type: 'user', id: 'subject-1' });

    expect(secrets.put.mock.calls[0]?.[3]).toBe(TOKEN);
  });

  it('refuses to store a token for an entry that provisions with a password', async () => {
    const { service, secrets, audit } = build({ entryKey: 'D07-01', kind: 'password' });

    await expect(
      service.store(INSTANCE_ID, TOKEN, { type: 'user', id: 'subject-1' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
    });
    expect(secrets.put).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('refuses to store a token for an entry with no provisioning adapter', async () => {
    const { service, secrets } = build({ entryKey: 'D01-01', kind: null });

    await expect(
      service.store(INSTANCE_ID, TOKEN, { type: 'user', id: 'subject-1' }),
    ).rejects.toBeInstanceOf(AppError);
    expect(secrets.put).not.toHaveBeenCalled();
  });

  it('refuses an empty token even though the schema would have caught it first', async () => {
    const { service, secrets } = build({ storedVersion: null });

    await expect(
      service.store(INSTANCE_ID, '   ', { type: 'user', id: 'subject-1' }),
    ).rejects.toMatchObject({
      status: 422,
    });
    expect(secrets.put).not.toHaveBeenCalled();
  });

  /**
   * AD-20: the mutation is fail-closed. If the operator's audit row cannot be appended, the secret
   * version must not survive on its own — the request that reported success would be a write the
   * chain never saw.
   */
  it('fails the whole write when the audit row cannot be appended', async () => {
    const { service } = build({ storedVersion: null, auditFailure: true });

    await expect(
      service.store(INSTANCE_ID, TOKEN, { type: 'user', id: 'subject-1' }),
    ).rejects.toThrow('audit chain unavailable');
  });
});
