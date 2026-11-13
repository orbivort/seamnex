import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Phase4DHandlers } from '../../../../src/contract/handlers/phase4d.handlers';
import type { OperationHandler } from '../../../../src/contract/operation-handler';
import { callHandler, operationInput } from '../../../support/operation-input';

let registry: { operations: ReturnType<typeof vi.fn> };
let handlers: ReadonlyMap<string, OperationHandler>;

beforeEach(() => {
  registry = { operations: vi.fn().mockResolvedValue([{ key: 'GET /jobs' }]) };
  handlers = new Phase4DHandlers(registry as never).handlers();
});

const call = (overrides = {}) =>
  callHandler(
    handlers,
    'GET /registry/operations',
    operationInput('GET /registry/operations', overrides),
  );

describe('GET /registry/operations', () => {
  it('dispatches the discovered operations for a target', async () => {
    const result = await call({ query: { target: 'mail' } });

    expect(registry.operations).toHaveBeenCalledWith('mail');
    expect(result).toEqual({ kind: 'body', body: [{ key: 'GET /jobs' }] });
  });

  it('refuses a request with no target', async () => {
    await expect(call({ query: {} })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
    });
  });

  it('refuses an empty target', async () => {
    await expect(call({ query: { target: '' } })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses a repeated target that arrives as an array', async () => {
    await expect(call({ query: { target: ['a', 'b'] } })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('tags the group phase-4d', () => {
    expect(new Phase4DHandlers(registry as never).tag).toBe('phase-4d');
  });
});
