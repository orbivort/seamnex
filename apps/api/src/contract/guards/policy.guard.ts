import { Inject, Injectable } from '@nestjs/common';
import { resourceForRequest } from '@seamnex/domain';
import { AppError } from '../../common/problem/app-error';
import { MFA_REASON, PdpService } from '../../modules/m09-access-control/pdp.service';
import type { OperationGuard, OperationGuardContext } from './operation-guard';

/**
 * The authorization decision, for every operation that is not explicitly anonymous.
 *
 * Anonymous lists are declared, not inferred: the allowlist is pinned by the route-policy check,
 * and the PDP never sees them. Most operations carry one capability; the few that declare an
 * any-of set (the elevation register) are decided as a single decision by `decideAny`, so an
 * approver loading the queue does not produce a refusal per capability they do not hold.
 */
@Injectable()
export class PolicyGuard implements OperationGuard {
  readonly phase = 'after-context' as const;

  constructor(@Inject(PdpService) private readonly pdp: PdpService) {}

  async canActivate({ operation, request, context }: OperationGuardContext): Promise<void> {
    if (context === undefined) return;
    if (operation.anonymous === true) return;

    const params = (request.params ?? {}) as Record<string, string>;
    const resource = resourceForRequest(operation.path, params);

    const decision =
      operation.policyAnyOf === undefined
        ? await this.pdp.decide({ context, policyKey: operation.policyKey, resource })
        : await this.pdp.decideAny({
            context,
            policyKeys: operation.policyAnyOf,
            resource,
            declaredKey: operation.policyKey,
          });

    if (decision.allowed) return;

    /*
     * A step-up refusal is not a permission problem: the role holds the capability and a second
     * factor is what is missing, so the answer is "authenticate again", not "ask the owner". The
     * client treats it as a lapsed session and returns to sign-in.
     */
    if (decision.reason === MFA_REASON) {
      throw new AppError({
        code: 'MFA_REQUIRED',
        detail: `The ${operation.policyKey} capability requires a session with a satisfied second factor.`,
        remediation: 'Sign in again with your second factor. The refusal was audited.',
      });
    }

    throw new AppError({
      code: 'FORBIDDEN',
      detail: `The ${operation.policyKey} capability is not granted for this resource.`,
      remediation:
        'Ask the scope owner for the capability, or use the request-access flow. The refusal was audited.',
    });
  }
}
