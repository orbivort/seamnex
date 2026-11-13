import { Inject, Injectable } from '@nestjs/common';
import { runWithContext, type RequestContext } from '../../common/identity/request-context';
import { AppError } from '../../common/problem/app-error';
import {
  OPERATION_GUARDS,
  type OperationGuard,
  type OperationGuardContext,
} from './operation-guard';

/**
 * Runs the guards in a fixed order and hands the caller a dispatch callback that already has the
 * request context bound.
 *
 * The order is the one the dispatcher used inline, and it is load-bearing: identity precedes the
 * cross-site check so an unauthenticated request is a 401 rather than a confusing 403, and policy
 * precedes validation so a refusal never depends on how well-formed the body is.
 */
@Injectable()
export class OperationGuardChain {
  private readonly before: readonly OperationGuard[];
  private readonly after: readonly OperationGuard[];

  constructor(@Inject(OPERATION_GUARDS) guards: readonly OperationGuard[]) {
    this.before = guards.filter((guard) => guard.phase === 'before-context');
    this.after = guards.filter((guard) => guard.phase === 'after-context');
  }

  /**
   * `fn` runs inside `runWithContext`, so a service three calls deep logs with the same request id
   * without receiving it as a parameter.
   */
  async run<T>(
    input: OperationGuardContext,
    fn: (context: RequestContext) => Promise<T>,
  ): Promise<T> {
    for (const guard of this.before) await guard.canActivate(input);

    const context = input.context;
    if (context === undefined) {
      // A configuration error, not a request error: the identity guard is always registered.
      throw new AppError({
        code: 'INTERNAL_ERROR',
        detail: 'The request context was not resolved before the guarded phase started.',
        remediation: 'This is a defect in the guard registration, not in the request.',
      });
    }

    return runWithContext(context, async () => {
      for (const guard of this.after) await guard.canActivate(input);
      return fn(context);
    });
  }
}
