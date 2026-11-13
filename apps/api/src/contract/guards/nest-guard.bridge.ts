import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { headerValue, parseCookies } from '../../common/http/cookies';
import { operationForRequest } from '../operation-lookup';
import { OperationGuardChain } from './operation-guard.chain';

/**
 * The `CanActivate` face of the same guard chain, registered as `APP_GUARD`.
 *
 * The contract dispatcher runs the chain directly (it is a raw Fastify route). This bridge exists
 * so that a *controller* route — the health endpoints today, anything added later — is protected by
 * the same code instead of having none. It resolves the operation from the declared route table, so
 * a route whose path is not in the contract is untouched, and a route that is declared cannot be
 * mounted unprotected.
 */
@Injectable()
export class OperationGuardBridge implements CanActivate {
  constructor(@Inject(OperationGuardChain) private readonly chain: OperationGuardChain) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const operation = operationForRequest(request);
    if (operation === undefined) return true;

    await this.chain.run(
      {
        operation,
        request,
        cookies: parseCookies(headerValue(request.headers, 'cookie')),
      },
      () => Promise.resolve(undefined),
    );
    return true;
  }
}
