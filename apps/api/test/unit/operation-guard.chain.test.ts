import type { ApiOperation } from '@seamnex/domain';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { currentContext, type RequestContext } from '../../src/common/identity/request-context';
import { requestStore } from '../../src/common/logging/logger';
import { AppError } from '../../src/common/problem/app-error';
import { OperationGuardChain } from '../../src/contract/guards/operation-guard.chain';
import type {
  OperationGuard,
  OperationGuardContext,
} from '../../src/contract/guards/operation-guard';

/**
 * The guard chain replaced five inline stages in the dispatcher. The properties that matter are the
 * ones the inline version guaranteed implicitly: the order, the fact that everything after identity
 * runs inside the request context, and the fact that a missing identity is a bug rather than a
 * request that proceeds unauthenticated.
 */

const request = {
  ip: '127.0.0.1',
  method: 'GET',
  headers: {},
  params: {},
  query: {},
} as unknown as FastifyRequest;

const operation = {
  method: 'GET',
  path: '/instances',
  policyKey: 'instance.read',
  anonymous: false,
} as unknown as ApiOperation;

function contextFor(): RequestContext {
  return {
    requestId: 'rid-guard',
    processRole: 'api',
    subject: { idpId: 'sub-1', username: 'ada' },
    role: 'R3',
    actorType: 'user',
    sessionId: 'sid-1',
    instanceId: null,
    scopes: [],
    mfaSatisfied: true,
    mfaMethod: 'totp',
    mfaAsserted: true,
    sessionExpiresAt: null,
    sessionIdleExpiresAt: null,
    csrfToken: 'csrf',
    groups: [],
  } as RequestContext;
}

function recorder(order: string[], name: string, phase: OperationGuard['phase']): OperationGuard {
  return {
    phase,
    canActivate: (input: OperationGuardContext) => {
      order.push(name);
      // The first pre-context guard is the one that publishes the context, as `IdentityGuard` does.
      if (phase === 'before-context' && input.context === undefined) input.context = contextFor();
      return Promise.resolve();
    },
  };
}

describe('operation guard chain', () => {
  it('runs the pre-context phase before the post-context phase, in registration order', async () => {
    const order: string[] = [];
    const chain = new OperationGuardChain([
      // Deliberately interleaved: the partition must come from `phase`, not from position.
      recorder(order, 'after-1', 'after-context'),
      recorder(order, 'before-1', 'before-context'),
      recorder(order, 'after-2', 'after-context'),
      recorder(order, 'before-2', 'before-context'),
    ]);

    await chain.run({ operation, request, cookies: {} }, () => {
      order.push('handler');
      return Promise.resolve(undefined);
    });

    expect(order).toEqual(['before-1', 'before-2', 'after-1', 'after-2', 'handler']);
  });

  it('binds the request context for the post-context guards and the handler', async () => {
    const seen: (string | undefined)[] = [];
    const chain = new OperationGuardChain([
      {
        phase: 'before-context',
        canActivate: (input) => {
          input.context = contextFor();
          return Promise.resolve();
        },
      },
      {
        phase: 'after-context',
        canActivate: () => {
          seen.push(currentContext()?.requestId);
          seen.push(requestStore.getStore()?.requestId);
          return Promise.resolve();
        },
      },
    ]);

    const context = await chain.run({ operation, request, cookies: {} }, (resolved) => {
      seen.push(currentContext()?.requestId);
      return Promise.resolve(resolved);
    });

    expect(context.requestId).toBe('rid-guard');
    // The identity store and the logging store must agree: an audit row and a log line that
    // disagree on the request id make an incident unreconstructable.
    expect(seen).toEqual(['rid-guard', 'rid-guard', 'rid-guard']);
  });

  it('refuses to dispatch when no guard published a context', async () => {
    const chain = new OperationGuardChain([
      { phase: 'before-context', canActivate: () => Promise.resolve() },
    ]);

    await expect(
      chain.run({ operation, request, cookies: {} }, () => Promise.resolve(1)),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('stops at the first refusal and never reaches the handler', async () => {
    let reached = false;
    const chain = new OperationGuardChain([
      {
        phase: 'before-context',
        canActivate: () => {
          throw new AppError({ code: 'UNAUTHORIZED', detail: 'no session' });
        },
      },
    ]);

    await expect(
      chain.run({ operation, request, cookies: {} }, () => {
        reached = true;
        return Promise.resolve(undefined);
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(reached).toBe(false);
  });
});
