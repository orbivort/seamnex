import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Lock } from 'lucide-react';
import type { Capability } from '@seamnex/domain';
import { ROLE_LABELS, scopedReason } from '@seamnex/domain';
import { EmptyState, Panel, PanelHeader, buttonVariants } from '@seamnex/ui';
import { capabilityGates as gates } from '../use-capabilities';
import { useSession } from '../session';

/**
 * The console's refusal panel.
 *
 * `capability` is optional because a gate can refuse an entry that declared no capability at all —
 * a wiring defect the navigation test catches, but not a reason to render a sentence about a
 * capability nobody asked for.
 */
export function Forbidden({
  capability,
  title = 'This section is not permitted for your role',
}: {
  // Explicit `| undefined`: `exactOptionalPropertyTypes` distinguishes "absent" from "present and
  // undefined", and a gate refuses with the latter when an entry declared no capability.
  capability?: Capability | undefined;
  title?: string;
}) {
  const { session } = useSession();
  return (
    <Panel className="mx-auto mt-6 max-w-2xl">
      <PanelHeader eyebrow="403 · deny by default" title={title} />
      <div className="p-6">
        <EmptyState
          icon={<Lock className="size-5" />}
          title={`${session.role} · ${ROLE_LABELS[session.role].name}`}
          description={
            capability === undefined
              ? 'This console section declares no capability, so it cannot be admitted for any role.'
              : scopedReason(session.role, capability)
          }
          action={
            <Link to="/" className={buttonVariants({ variant: 'secondary' })}>
              Back to overview
            </Link>
          }
        />
        {capability === undefined ? null : (
          <p className="mt-2 text-center font-mono text-micro text-faint">
            capability: {capability}
          </p>
        )}
      </div>
    </Panel>
  );
}

/**
 * The console gates, bound to its own refusal panel (ADR-FE-01).
 *
 * Named components rather than one with a mode: the route table reads as prose
 * (`RequireAnyCapability` at the maintenance screen says what it means). The decision itself is the
 * shared one from `@seamnex/shell`; these are presentation bindings around it.
 *
 * The aliases exist so each gate is mounted as an element rather than called as a function: a gate
 * that runs inside its caller's hook scope is legal only while the caller never branches, and a
 * route table is exactly the place where a future branch would look innocuous.
 */
const AnyCapability = gates.RequireCapability;
const FullCapability = gates.RequireFullCapability;
const AnyOfCapabilities = gates.RequireAnyCapability;
const AnyOfFullCapabilities = gates.RequireAnyFullCapability;

export function RequireCapability({
  capability,
  children,
  title,
}: {
  capability: Capability;
  children: ReactNode;
  title?: string;
}) {
  return (
    <AnyCapability
      capability={capability}
      fallback={(denied) => <Forbidden capability={denied} {...(title ? { title } : {})} />}
    >
      {children}
    </AnyCapability>
  );
}

export function RequireFullCapability({
  capability,
  children,
}: {
  capability: Capability;
  children: ReactNode;
}) {
  return (
    <FullCapability
      capability={capability}
      fallback={(denied) => <Forbidden capability={denied} />}
    >
      {children}
    </FullCapability>
  );
}

export function RequireAnyCapability({
  capabilities,
  children,
}: {
  capabilities: Capability[];
  children: ReactNode;
}) {
  return (
    <AnyOfCapabilities
      capabilities={capabilities}
      fallback={(denied) => <Forbidden capability={denied} />}
    >
      {children}
    </AnyOfCapabilities>
  );
}

export function RequireAnyFullCapability({
  capabilities,
  children,
}: {
  capabilities: Capability[];
  children: ReactNode;
}) {
  return (
    <AnyOfFullCapabilities
      capabilities={capabilities}
      fallback={(denied) => <Forbidden capability={denied} />}
    >
      {children}
    </AnyOfFullCapabilities>
  );
}

export function ForbiddenRoles() {
  const { session } = useSession();
  // The portal origin is configuration, so a deployed console never links to localhost.
  const configuredPortal = import.meta.env.VITE_PORTAL_URL;
  const portalBase =
    typeof configuredPortal === 'string' && configuredPortal.length > 0
      ? configuredPortal.replace(/\/+$/, '')
      : // The dev servers speak TLS (ADR-BE-39); a bare `http` default would link to a closed port.
        'https://localhost:5173';
  return (
    <Panel className="mx-auto mt-6 max-w-2xl">
      <PanelHeader
        eyebrow="Not an operator surface"
        title="The console is for platform and domain operators"
      />
      <div className="p-6">
        <EmptyState
          icon={<Lock className="size-5" />}
          title={`${session.role} · ${ROLE_LABELS[session.role].name}`}
          description="End users and guests use the portal, not the console. Ask a domain owner if you need a granting role."
          action={
            <a href={`${portalBase}/?role=R5`} className={buttonVariants({ variant: 'secondary' })}>
              Open the portal
            </a>
          }
        />
      </div>
    </Panel>
  );
}
