import type { ApiOperation } from '@seamnex/domain';
import type { FastifyRequest } from 'fastify';
import type { RequestContext } from '../../common/identity/request-context';

/**
 * One request, before any handler sees it.
 *
 * These were five inline stages inside `RouteTableService.handle`, which meant they were reachable
 * from exactly one place: the contract dispatcher. A controller route had no authentication, no
 * cross-site check and no policy decision available to it, and no way to get one.
 *
 * A guard throws `AppError` to refuse and returns normally to pass. It never touches the reply:
 * status, headers and the problem document belong to `sendProblem`.
 */
export type OperationGuardContext = {
  readonly operation: ApiOperation;
  readonly request: FastifyRequest;
  readonly cookies: Readonly<Record<string, string>>;
  /**
   * Published by `IdentityGuard` and read by every later guard and by the dispatch callback.
   * `undefined` before that point — which is what the two phases exist to guarantee.
   */
  context?: RequestContext;
};

/**
 * `before-context` guards run outside the request's AsyncLocalStorage scope and must not log with
 * a request id; `after-context` guards run inside it. Splitting the two is what preserves the
 * original order — rate limit, then identity, then cross-site, then policy — while letting the
 * whole authorised phase log under one id.
 */
export type OperationGuardPhase = 'before-context' | 'after-context';

export interface OperationGuard {
  readonly phase: OperationGuardPhase;
  /** Throws `AppError` to refuse. */
  canActivate(input: OperationGuardContext): Promise<void>;
}

export const OPERATION_GUARDS = Symbol('seamnex.contract.guards');
