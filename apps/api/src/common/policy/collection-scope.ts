import type { CollectionScope } from '@seamnex/domain';
import type { RequestContext } from '../identity/request-context';
import { AppError } from '../problem/app-error';

/**
 * ADR-BE-44 — the predicate a collection read must apply.
 *
 * The policy guard publishes the scope on the request context after an allow, so a handler that
 * reads a collection has exactly one way to learn what it may see. It lives in `common/` rather
 * than in m09 because it is request plumbing, not a module capability: a handler importing it must
 * not take a dependency on the policy implementation.
 *
 * Re-deriving the grants in the handler would create a second answer that could disagree with the
 * decision that let the request through; defaulting to "no filter" would turn a wiring mistake into
 * a disclosure. Hence the throw: a collection allow that lost its predicate fails closed.
 */
export function requireCollectionScope(context: RequestContext): CollectionScope {
  const scope = context.policyScope;
  if (scope === undefined) {
    throw new AppError({
      code: 'INTERNAL_ERROR',
      detail: 'A collection read reached its handler without a scope.',
      remediation: 'This is a defect in the policy wiring, not in the request.',
    });
  }
  return scope;
}
