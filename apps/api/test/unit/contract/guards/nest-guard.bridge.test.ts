import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { OperationGuardBridge } from '../../../../src/contract/guards/nest-guard.bridge';
import { operationOf } from '../../../support/operation-input';

function executionContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function bridge(chain: { run: ReturnType<typeof vi.fn> }): OperationGuardBridge {
  return new OperationGuardBridge(chain as never);
}

describe('OperationGuardBridge', () => {
  it('leaves a route that is not in the contract untouched', async () => {
    const chain = { run: vi.fn() };
    const allowed = await bridge(chain).canActivate(
      executionContext({ method: 'GET', routeOptions: { url: '/healthz' }, headers: {} }),
    );

    expect(allowed).toBe(true);
    expect(chain.run).not.toHaveBeenCalled();
  });

  it('leaves a request with no route template untouched', async () => {
    const chain = { run: vi.fn() };
    const allowed = await bridge(chain).canActivate(
      executionContext({ method: 'GET', headers: {} }),
    );
    expect(allowed).toBe(true);
    expect(chain.run).not.toHaveBeenCalled();
  });

  it('runs the chain for a declared controller route', async () => {
    const chain = { run: vi.fn().mockImplementation((_input, fn) => fn()) };
    const request = {
      method: 'GET',
      routeOptions: { url: '/api/v1/jobs' },
      headers: { cookie: 'seamnex_session=abc; seamnex_csrf=token' },
    };

    const allowed = await bridge(chain).canActivate(executionContext(request));

    expect(allowed).toBe(true);
    expect(chain.run).toHaveBeenCalledOnce();
    const [input, fn] = chain.run.mock.calls[0] as [
      { operation: unknown; cookies: Record<string, string> },
      () => Promise<unknown>,
    ];
    expect(input.operation).toBe(operationOf('GET /jobs'));
    expect(input.cookies).toEqual({ seamnex_session: 'abc', seamnex_csrf: 'token' });
    await expect(fn()).resolves.toBeUndefined();
  });

  it('propagates a refusal from the chain', async () => {
    const refusal = new Error('FORBIDDEN');
    const chain = { run: vi.fn().mockRejectedValue(refusal) };

    await expect(
      bridge(chain).canActivate(
        executionContext({
          method: 'POST',
          routeOptions: { url: '/api/v1/jobs/:id/cancel' },
          headers: {},
        }),
      ),
    ).rejects.toBe(refusal);
  });

  it('accepts a route template that already omits the api prefix', async () => {
    const chain = { run: vi.fn().mockImplementation((_input, fn) => fn()) };
    const allowed = await bridge(chain).canActivate(
      executionContext({ method: 'GET', routeOptions: { url: '/jobs/:id' }, headers: {} }),
    );
    expect(allowed).toBe(true);
  });
});
