import { describe, expect, it } from 'vitest';
import type { CollectionScope } from '@seamnex/domain';
import { requireCollectionScope } from '../../../../src/common/policy/collection-scope';
import { AppError } from '../../../../src/common/problem/app-error';
import { testContext } from '../../../support/operation-input';

const SCOPED: CollectionScope = {
  kind: 'scoped',
  domains: ['CRM & Sales Pipeline'],
  instanceIds: ['4c3f0a66-0000-4000-8000-000000000001'],
};

describe('requireCollectionScope', () => {
  it('returns the scope the policy guard published, unchanged', () => {
    // The very same object, not a copy: the handler filters with the predicate the decision produced,
    // so a second derivation with a different answer cannot exist.
    expect(requireCollectionScope(testContext({ policyScope: SCOPED }))).toBe(SCOPED);
  });

  it('returns a platform-wide scope as it stands', () => {
    const platform: CollectionScope = { kind: 'platform' };
    expect(requireCollectionScope(testContext({ policyScope: platform }))).toBe(platform);
  });

  it('fails closed when a collection read reached the handler without a scope', () => {
    // ADR-BE-44: absence is a wiring defect. Defaulting to "no filter" would turn it into a
    // disclosure, so the read must throw rather than answer.
    const context = testContext();
    delete context.policyScope;

    let thrown: unknown;
    try {
      requireCollectionScope(context);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect((thrown as AppError).detail).toContain('without a scope');
    expect((thrown as AppError).remediation).toContain('wiring');
  });
});
