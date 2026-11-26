import type { ReactNode } from 'react';
import { accessFor, type Capability } from '@seamnex/domain';
import { useSession } from '../session';

/**
 * ADR-FE-01 — the line a scope-limited screen prints with its numbers.
 *
 * The sidebar marks the entry; this says the same thing where the numbers are. "0 results" and
 * "the rows your grant covers number 0" are different statements, and only the second one is true
 * for a domain-scoped operator looking at a filtered list.
 *
 * It renders nothing for a `full` grant: an unrestricted screen should not explain a scope it does
 * not have.
 */
export function ScopeNote({
  capability,
  children,
}: {
  capability: Capability;
  children?: ReactNode;
}) {
  const { session } = useSession();
  if (accessFor(session.role, capability) !== 'scoped') return null;
  return (
    <p className="mt-2 max-w-3xl text-meta leading-relaxed text-muted" data-testid="scope-note">
      <span className="label-caps-sans mr-1.5 text-warning-strong">Scoped</span>
      {children ??
        `${session.role} holds this capability within a narrower scope, so this view lists only the rows your grant covers.`}
    </p>
  );
}
