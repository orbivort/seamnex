import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Phase3Handlers } from '../../../../src/contract/handlers/phase3.handlers';
import type { OperationHandler } from '../../../../src/contract/operation-handler';
import { callHandler, operationInput } from '../../../support/operation-input';

let identity: { disableUser: ReturnType<typeof vi.fn>; runSync: ReturnType<typeof vi.fn> };
let handlers: ReadonlyMap<string, OperationHandler>;

beforeEach(() => {
  identity = {
    disableUser: vi.fn().mockResolvedValue({ id: 'u1', enabled: false }),
    runSync: vi.fn().mockResolvedValue({ id: 'run-1', state: 'queued' }),
  };
  handlers = new Phase3Handlers(identity as never).handlers();
});

const call = (key: string, overrides = {}) =>
  callHandler(handlers, key, operationInput(key, overrides));

describe('Phase3Handlers', () => {
  it('tags the group phase-3', () => {
    expect(new Phase3Handlers(identity as never).tag).toBe('phase-3');
  });

  it('POST /admin/users/:id/disable offboards as the caller', async () => {
    const result = await call('POST /admin/users/:id/disable', { params: { id: 'u1' } });

    expect(identity.disableUser).toHaveBeenCalledWith('u1', 'sub-1');
    expect(result).toEqual({ kind: 'body', body: { id: 'u1', enabled: false } });
  });

  it('POST /admin/users/:id/disable sends an empty id when none is present', async () => {
    await call('POST /admin/users/:id/disable', { params: {} });
    expect(identity.disableUser).toHaveBeenCalledWith('', 'sub-1');
  });

  it('POST /admin/identity-sync/run forces a cycle as the caller', async () => {
    const result = await call('POST /admin/identity-sync/run');

    expect(identity.runSync).toHaveBeenCalledWith('sub-1');
    expect(result).toEqual({ kind: 'body', body: { id: 'run-1', state: 'queued' } });
  });

  it('propagates a service refusal', async () => {
    identity.disableUser.mockRejectedValue(new Error('provider refused'));
    await expect(call('POST /admin/users/:id/disable', { params: { id: 'u1' } })).rejects.toThrow(
      'provider refused',
    );
  });

  it('implements the two Phase 3 mutations', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'POST /admin/identity-sync/run',
      'POST /admin/users/:id/disable',
    ]);
  });
});
