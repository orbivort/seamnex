import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import type { ApiOperation } from '@seamnex/domain';
import { CsrfGuard } from '../../../../src/contract/guards/csrf.guard';
import type { OperationGuardContext } from '../../../../src/contract/guards/operation-guard';
import { AppError } from '../../../../src/common/problem/app-error';
import { operationOf, testContext } from '../../../support/operation-input';

const CONFIG = {
  allowedOrigins: ['https://portal.test'],
  CSRF_COOKIE_NAME: 'seamnex_csrf',
} as unknown as AppConfig;

const TOKEN = 'csrf-token';

function context(overrides: Partial<OperationGuardContext> = {}): OperationGuardContext {
  return {
    operation: operationOf('POST /jobs/:id/cancel'),
    request: {
      method: 'POST',
      headers: { origin: 'https://portal.test', 'x-seamnex-csrf': TOKEN },
    } as never,
    cookies: { seamnex_csrf: TOKEN },
    context: testContext({ csrfToken: TOKEN }),
    ...overrides,
  };
}

function guard(): CsrfGuard {
  return new CsrfGuard(CONFIG);
}

/**
 * `canActivate` is declared async but the two checks it runs are synchronous, so a refusal is a
 * synchronous throw rather than a rejected promise. The wrapper makes the assertion independent of
 * which of the two shapes a guard happens to use.
 */
async function refuses(run: () => Promise<void> | void): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the CSRF guard to refuse');
}

describe('CsrfGuard', () => {
  it('is an after-context guard', () => {
    expect(guard().phase).toBe('after-context');
  });

  it('skips before an identity is resolved', async () => {
    // The dispatcher builds the guard input without a `context`; `IdentityGuard` publishes it.
    const beforeIdentity = { ...context() };
    delete beforeIdentity.context;

    await expect(guard().canActivate(beforeIdentity)).resolves.toBeUndefined();
  });

  it('exempts a machine actor, which a browser cannot forge', async () => {
    const machine = testContext({ actorType: 'service', csrfToken: null });
    await expect(
      guard().canActivate(
        context({
          context: machine,
          cookies: {},
          request: { method: 'POST', headers: {} } as never,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('exempts safe methods', async () => {
    const operation = operationOf('GET /jobs');
    await expect(
      guard().canActivate(
        context({ operation, request: { method: 'GET', headers: {} } as never, cookies: {} }),
      ),
    ).resolves.toBeUndefined();
  });

  it('exempts POST /auth/session, which replaces the session it would check', async () => {
    const operation = operationOf('POST /auth/session');
    await expect(
      guard().canActivate(
        context({ operation, request: { method: 'POST', headers: {} } as never, cookies: {} }),
      ),
    ).resolves.toBeUndefined();
  });

  it('accepts a matching origin, header and cookie', async () => {
    await expect(guard().canActivate(context())).resolves.toBeUndefined();
  });

  it('refuses a cross-site request before comparing tokens', async () => {
    const error = await refuses(() =>
      guard().canActivate(
        context({
          request: {
            method: 'POST',
            headers: { origin: 'https://portal.test', 'sec-fetch-site': 'cross-site' },
          } as never,
        }),
      ),
    );
    expect(error.code).toBe('ORIGIN_REJECTED');
  });

  it('refuses an unsafe request with no origin', async () => {
    const error = await refuses(() =>
      guard().canActivate(
        context({ request: { method: 'POST', headers: {} } as never, cookies: {} }),
      ),
    );
    expect(error.code).toBe('ORIGIN_REJECTED');
  });

  it('refuses an unsafe request whose token does not match the session', async () => {
    const error = await refuses(() =>
      guard().canActivate(
        context({
          request: {
            method: 'POST',
            headers: { origin: 'https://portal.test', 'x-seamnex-csrf': 'other' },
          } as never,
        }),
      ),
    );
    expect(error.code).toBe('CSRF_FAILED');
  });

  it('refuses a session with no CSRF token when one is demanded', async () => {
    const noToken = testContext({ csrfToken: null });
    const error = await refuses(() =>
      guard().canActivate(
        context({
          context: noToken,
          request: {
            method: 'POST',
            headers: { origin: 'https://portal.test', 'x-seamnex-csrf': '' },
          } as never,
        }),
      ),
    );
    expect(error.code).toBe('CSRF_FAILED');
  });

  it('accepts a repeated origin header by using its first value', async () => {
    await expect(
      guard().canActivate(
        context({
          request: {
            method: 'POST',
            headers: {
              origin: ['https://portal.test', 'https://other.test'],
              'x-seamnex-csrf': TOKEN,
            },
          } as never,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('applies to DELETE and PATCH as well', async () => {
    for (const operation of [
      operationOf('DELETE /workflows/:id'),
      operationOf('PATCH /workflows/:id'),
    ]) {
      const unsafe = { ...operation, method: operation.method } as ApiOperation;
      await expect(
        guard().canActivate(
          context({
            operation: unsafe,
            request: {
              method: operation.method,
              headers: { origin: 'https://portal.test', 'x-seamnex-csrf': TOKEN },
            } as never,
          }),
        ),
      ).resolves.toBeUndefined();
    }
  });
});
