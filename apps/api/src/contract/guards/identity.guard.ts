import { Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { IDENTITY_RESOLVER, type IdentityResolver } from '../../common/identity/identity.resolver';
import type { OperationGuard, OperationGuardContext } from './operation-guard';

/**
 * Resolves who is calling, and publishes it for everything downstream.
 *
 * It runs before the cross-site check on purpose: an unauthenticated request must be answered 401
 * even when the operation is deferred, otherwise the phase map leaks to anonymous callers — and a
 * 403 for a missing session would send the user looking for a permission they never needed.
 */
@Injectable()
export class IdentityGuard implements OperationGuard {
  readonly phase = 'before-context' as const;

  constructor(@Inject(IDENTITY_RESOLVER) private readonly identity: IdentityResolver) {}

  async canActivate(input: OperationGuardContext): Promise<void> {
    input.context = await this.identity.resolve(
      input.request as FastifyRequest & { requestId?: string },
      input.operation,
    );
  }
}
