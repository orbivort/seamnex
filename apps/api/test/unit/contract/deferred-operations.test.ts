import { describe, expect, it } from 'vitest';
import { DEFERRED_OPERATIONS, deferredProblem } from '../../../src/contract/deferred-operations';
import { isKnownProblemCode } from '../../../src/common/problem/problem-catalog';

describe('deferred operations', () => {
  it('is empty at the Phase 4 exit state', () => {
    expect(DEFERRED_OPERATIONS.size).toBe(0);
  });

  it('explains a declared operation with no handler as a defect, not a silent no-op', () => {
    const problem = deferredProblem('GET /jobs');

    expect(problem.code).toBe('OPERATION_NOT_IMPLEMENTED');
    expect(isKnownProblemCode(problem.code)).toBe(true);
    expect(problem.detail).toContain('GET /jobs');
    expect(problem.remediation).toContain('registry parity test');
  });
});
