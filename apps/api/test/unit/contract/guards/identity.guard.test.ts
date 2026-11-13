import { describe, expect, it, vi } from 'vitest';
import { IdentityGuard } from '../../../../src/contract/guards/identity.guard';
import type { OperationGuardContext } from '../../../../src/contract/guards/operation-guard';
import { operationOf, testContext } from '../../../support/operation-input';

describe('IdentityGuard', () => {
  it('is a before-context guard, so an unauthenticated request is a 401', () => {
    expect(new IdentityGuard({ resolve: vi.fn() } as never).phase).toBe('before-context');
  });

  it('resolves the identity and publishes it on the input', async () => {
    const resolved = testContext({ requestId: 'rid-identity' });
    const resolve = vi.fn().mockResolvedValue(resolved);
    const guard = new IdentityGuard({ resolve } as never);

    const input: OperationGuardContext = {
      operation: operationOf('GET /jobs'),
      request: { method: 'GET', headers: {} } as never,
      cookies: {},
    };

    await guard.canActivate(input);

    expect(resolve).toHaveBeenCalledWith(input.request, input.operation);
    expect(input.context).toBe(resolved);
  });

  it('propagates a refusal from the resolver unchanged', async () => {
    const refusal = new Error('UNAUTHORIZED');
    const guard = new IdentityGuard({ resolve: vi.fn().mockRejectedValue(refusal) } as never);

    await expect(
      guard.canActivate({
        operation: operationOf('GET /jobs'),
        request: {} as never,
        cookies: {},
      }),
    ).rejects.toBe(refusal);
  });
});
