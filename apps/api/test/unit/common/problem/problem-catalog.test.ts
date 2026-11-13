import { describe, expect, it } from 'vitest';
import { ProblemDetailSchema } from '@seamnex/domain';
import { PROBLEM_CATALOG, problemFor } from '../../../../src/common/problem/problem-catalog';

describe('problem catalogue', () => {
  it('renders every code as a contract-valid problem document', () => {
    for (const code of Object.keys(PROBLEM_CATALOG)) {
      const problem = problemFor(code as keyof typeof PROBLEM_CATALOG, {
        detail: `detail for ${code}`,
      });
      const parsed = ProblemDetailSchema.safeParse(problem);
      expect(
        parsed.success,
        `${code}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
      ).toBe(true);
      expect(problem.status).toBeGreaterThanOrEqual(400);
      expect(problem.remediation.length).toBeGreaterThan(10);
    }
  });

  it('keeps a unique type URI per code', () => {
    const types = Object.keys(PROBLEM_CATALOG).map(
      (code) => problemFor(code as keyof typeof PROBLEM_CATALOG, { detail: 'x' }).type,
    );
    expect(new Set(types).size).toBe(types.length);
  });

  it('carries field errors through for a validation failure', () => {
    const problem = problemFor('VALIDATION_FAILED', {
      detail: 'bad body',
      fieldErrors: [
        { field: 'slug', code: 'too_small', message: 'Expected at least 2 characters' },
      ],
    });
    expect(problem.fieldErrors).toHaveLength(1);
    expect(problem.code).toBe('VALIDATION_FAILED');
  });

  it('publishes the audit refusal as a 503 so a retry is the documented action (AD-20)', () => {
    expect(problemFor('AUDIT_UNAVAILABLE', { detail: 'x' }).status).toBe(503);
  });
});
