import { describe, expect, it, vi } from 'vitest';
import type { ApiOperation } from '@seamnex/domain';
import { PolicyGuard, policyRefusalDetail } from '../../../../src/contract/guards/policy.guard';
import type { OperationGuardContext } from '../../../../src/contract/guards/operation-guard';
import { MFA_REASON } from '../../../../src/modules/m09-access-control/pdp.service';
import { AppError } from '../../../../src/common/problem/app-error';
import { operationOf, testContext } from '../../../support/operation-input';

function context(overrides: Partial<OperationGuardContext> = {}): OperationGuardContext {
  return {
    operation: operationOf('GET /jobs'),
    request: { method: 'GET', params: {} } as never,
    cookies: {},
    context: testContext(),
    ...overrides,
  };
}

function pdpDouble(
  options: {
    allowed?: boolean;
    reason?: string;
    anyOf?: boolean;
  } = {},
) {
  const decide = vi.fn().mockResolvedValue({
    allowed: options.allowed ?? true,
    policyVersion: 1,
    reason: options.reason ?? 'role grants it',
  });
  const decideAny = vi.fn().mockResolvedValue({
    allowed: options.allowed ?? true,
    policyVersion: 1,
    reason: options.reason ?? 'role grants it',
  });
  return { decide, decideAny } as unknown as { decide: typeof decide; decideAny: typeof decideAny };
}

async function refuses(run: Promise<void>): Promise<AppError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the policy guard to refuse');
}

describe('PolicyGuard', () => {
  it('does nothing before an identity is resolved', async () => {
    const pdp = pdpDouble();
    const guard = new PolicyGuard(pdp as never);
    // The dispatcher builds the guard input without a `context`; `IdentityGuard` publishes it.
    const beforeIdentity = { ...context() };
    delete beforeIdentity.context;

    await guard.canActivate(beforeIdentity);
    expect(pdp.decide).not.toHaveBeenCalled();
  });

  it('does nothing for an explicitly anonymous operation', async () => {
    const pdp = pdpDouble();
    const guard = new PolicyGuard(pdp as never);
    const anonymous = { ...operationOf('GET /jobs'), anonymous: true } as ApiOperation;
    await guard.canActivate(context({ operation: anonymous }));
    expect(pdp.decide).not.toHaveBeenCalled();
  });

  it('passes the declared capability and the resource to the PDP', async () => {
    const pdp = pdpDouble();
    const guard = new PolicyGuard(pdp as never);
    await guard.canActivate(context());

    expect(pdp.decide).toHaveBeenCalledOnce();
    expect(pdp.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        policyKey: operationOf('GET /jobs').policyKey,
        resource: expect.anything(),
      }),
    );
  });

  it('allows a granted request without consulting the any-of path', async () => {
    const pdp = pdpDouble({ allowed: true });
    const guard = new PolicyGuard(pdp as never);
    await expect(guard.canActivate(context())).resolves.toBeUndefined();
    expect(pdp.decideAny).not.toHaveBeenCalled();
  });

  it('evaluates an any-of operation as one decision', async () => {
    const pdp = pdpDouble({ allowed: true });
    const guard = new PolicyGuard(pdp as never);
    const operation = {
      ...operationOf('GET /jobs'),
      policyAnyOf: ['jobs.read', 'audit.read'],
    } as unknown as ApiOperation;

    await guard.canActivate(context({ operation }));

    expect(pdp.decide).not.toHaveBeenCalled();
    expect(pdp.decideAny).toHaveBeenCalledWith(
      expect.objectContaining({ policyKeys: ['jobs.read', 'audit.read'] }),
    );
  });

  it('answers a step-up refusal with MFA_REQUIRED rather than FORBIDDEN', async () => {
    const pdp = pdpDouble({ allowed: false, reason: MFA_REASON });
    const guard = new PolicyGuard(pdp as never);

    const error = await refuses(guard.canActivate(context()));
    expect(error.code).toBe('MFA_REQUIRED');
    expect(error.detail).toContain(operationOf('GET /jobs').policyKey);
    expect(error.remediation).toContain('second factor');
  });

  it('answers a missing capability with FORBIDDEN and does not leak the resource', async () => {
    const pdp = pdpDouble({ allowed: false, reason: 'no grant' });
    const guard = new PolicyGuard(pdp as never);

    const error = await refuses(guard.canActivate(context()));
    expect(error.code).toBe('FORBIDDEN');
    // The exact wording is a contract: the authorization-matrix suite tells a policy refusal apart
    // from a handler's own `403` by it, so a reworded sentence must fail here rather than there.
    expect(error.detail).toBe(policyRefusalDetail(operationOf('GET /jobs').policyKey));
    expect(error.detail).toContain(operationOf('GET /jobs').policyKey);
    expect(error.remediation).toContain('request-access');
  });

  it('passes the route params to the resource projection', async () => {
    const pdp = pdpDouble({ allowed: false, reason: 'no grant' });
    const guard = new PolicyGuard(pdp as never);
    const operation = operationOf('GET /jobs/:id');

    await refuses(
      guard.canActivate(
        context({ operation, request: { method: 'GET', params: { id: 'abc' } } as never }),
      ),
    );

    expect(pdp.decide).toHaveBeenCalledWith(
      expect.objectContaining({ resource: expect.objectContaining({ id: 'abc' }) }),
    );
  });

  it('tolerates a request with no params object', async () => {
    const pdp = pdpDouble({ allowed: true });
    const guard = new PolicyGuard(pdp as never);
    await expect(
      guard.canActivate(context({ request: { method: 'GET' } as never })),
    ).resolves.toBeUndefined();
  });
});
