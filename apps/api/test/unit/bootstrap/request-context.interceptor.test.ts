import { describe, expect, it } from 'vitest';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import type { AppConfig } from '../../../src/config/config';
import { RequestContextInterceptor } from '../../../src/bootstrap/request-context.interceptor';
import { currentRequestId, requestStore } from '../../../src/common/logging/logger';

const CONFIG = { SEAMNEX_ROLE: 'api' } as unknown as AppConfig;

function executionContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RequestContextInterceptor', () => {
  it('binds the request id Fastify minted to the handler continuation', async () => {
    const interceptor = new RequestContextInterceptor(CONFIG);
    const next: CallHandler = {
      handle: () => of(undefined),
    };

    let observed: string | undefined;
    const handler: CallHandler = {
      handle: () => {
        observed = currentRequestId();
        return of(undefined);
      },
    };

    await firstValueFrom(interceptor.intercept(executionContext({ requestId: 'rid-42' }), handler));

    expect(observed).toBe('rid-42');
    // The bind ends with the callback's async graph.
    expect(currentRequestId()).toBeUndefined();
    expect(next.handle).toBeDefined();
  });

  it('falls back to the sentinel id when the request carries none', async () => {
    const interceptor = new RequestContextInterceptor(CONFIG);

    let observed: string | undefined;
    await firstValueFrom(
      interceptor.intercept(executionContext({}), {
        handle: () => {
          observed = currentRequestId();
          return of(undefined);
        },
      }),
    );

    expect(observed).toBe('unknown');
  });

  it('enters the store per subscription, not once at call time', async () => {
    const interceptor = new RequestContextInterceptor(CONFIG);
    const seen: Array<string | undefined> = [];

    const observable = interceptor.intercept(executionContext({ requestId: 'rid-lazy' }), {
      handle: () => {
        seen.push(currentRequestId());
        return of(undefined);
      },
    });

    expect(seen).toEqual([]);
    await firstValueFrom(observable);
    await firstValueFrom(observable);
    expect(seen).toEqual(['rid-lazy', 'rid-lazy']);
  });

  it('carries the process role into the logging store', async () => {
    const interceptor = new RequestContextInterceptor({
      SEAMNEX_ROLE: 'scheduler',
    } as unknown as AppConfig);

    let observed: string | undefined;
    await firstValueFrom(
      interceptor.intercept(executionContext({ requestId: 'rid-role' }), {
        handle: () => {
          observed = requestStore.getStore()?.role;
          return of(undefined);
        },
      }),
    );

    expect(observed).toBe('scheduler');
  });
});
