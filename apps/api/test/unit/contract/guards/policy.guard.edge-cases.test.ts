import { describe, expect, it, vi } from 'vitest';
import type { ApiOperation } from '@seamnex/domain';
import { PolicyGuard } from '../../../../src/contract/guards/policy.guard';
import type { OperationGuardContext } from '../../../../src/contract/guards/operation-guard';
import { MFA_REASON } from '../../../../src/modules/m09-access-control/pdp.service';
import { AppError } from '../../../../src/common/problem/app-error';
import { operationOf, testContext } from '../../../support/operation-input';

/**
 * The any-of path is the one the main suite only exercises when it *allows*. A refusal on that path
 * has to produce the same two problem codes as a single-capability refusal, otherwise an approver
 * loading the elevation register is told to ask for a capability they already hold.
 */
const DECLARED = operationOf('GET /jobs').policyKey as string;
const ELEVATION = {
  ...operationOf('GET /jobs'),
  policyAnyOf: ['jobs.approve', DECLARED],
} as unknown as ApiOperation;

function context(operation: ApiOperation = ELEVATION): OperationGuardContext {
  return {
    operation,
    request: { method: 'GET', params: {} } as never,
    cookies: {},
    context: testContext(),
  };
}

function pdpDouble(decision: { allowed: boolean; reason: string }) {
  return {
    decide: vi.fn().mockResolvedValue({ policyVersion: 1, ...decision }),
    decideAny: vi.fn().mockResolvedValue({ policyVersion: 1, ...decision }),
  };
}

async function refusal(run: Promise<void>): Promise<AppError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the policy guard to refuse');
}

describe('an any-of operation that is refused', () => {
  it('answers FORBIDDEN for the declared key when no capability in the set is held', async () => {
    const pdp = pdpDouble({ allowed: false, reason: 'no grant' });
    const guard = new PolicyGuard(pdp as never);

    const error = await refusal(guard.canActivate(context()));

    expect(error.code).toBe('FORBIDDEN');
    expect(error.detail).toContain(DECLARED);
    expect(pdp.decide).not.toHaveBeenCalled();
    expect(pdp.decideAny).toHaveBeenCalledWith(
      expect.objectContaining({
        declaredKey: DECLARED,
        policyKeys: ['jobs.approve', DECLARED],
      }),
    );
  });

  it('answers MFA_REQUIRED when the missing piece is the second factor, not the capability', async () => {
    const pdp = pdpDouble({ allowed: false, reason: MFA_REASON });
    const guard = new PolicyGuard(pdp as never);

    const error = await refusal(guard.canActivate(context()));

    // A step-up refusal sends the client back to sign-in; it must not read as "ask the owner".
    expect(error.code).toBe('MFA_REQUIRED');
    expect(error.remediation).toContain('second factor');
  });
});

describe('a decision that allows the request', () => {
  it('returns without a refusal for every capability in the set', async () => {
    const pdp = pdpDouble({ allowed: true, reason: 'role grants it' });
    const guard = new PolicyGuard(pdp as never);

    await expect(guard.canActivate(context())).resolves.toBeUndefined();
  });
});
