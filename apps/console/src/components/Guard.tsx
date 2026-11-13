import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Lock } from 'lucide-react';
import type { Capability } from '@seamnex/domain';
import { ROLE_LABELS, scopedReason } from '@seamnex/domain';
import { EmptyState, Panel, PanelHeader, buttonVariants } from '@seamnex/ui';
import { useCapabilities } from '../use-capabilities';
import { useSession } from '../session';

export function Forbidden({
  capability,
  title = 'This section is not permitted for your role',
}: {
  capability: Capability;
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
          description={scopedReason(session.role, capability)}
          action={
            <Link to="/" className={buttonVariants({ variant: 'secondary' })}>
              Back to overview
            </Link>
          }
        />
        <p className="mt-2 text-center font-mono text-micro text-faint">capability: {capability}</p>
      </div>
    </Panel>
  );
}

export function RequireCapability({
  capability,
  children,
  title,
}: {
  capability: Capability;
  children: ReactNode;
  title?: string;
}) {
  // The capability set is derived once per role, so this gate is a membership test rather than a
  // matrix lookup on every render of the route it wraps.
  const { held } = useCapabilities();
  if (!held.has(capability)) {
    return <Forbidden capability={capability} {...(title ? { title } : {})} />;
  }
  return <>{children}</>;
}

export function RequireFullCapability({
  capability,
  children,
}: {
  capability: Capability;
  children: ReactNode;
}) {
  // `mutable`, not `held`: an admin surface is only enterable on an outright grant, exactly what
  // `canMutate` answered before.
  const { mutable } = useCapabilities();
  if (!mutable.has(capability)) {
    return <Forbidden capability={capability} />;
  }
  return <>{children}</>;
}

export function RequireAnyCapability({
  capabilities,
  children,
}: {
  capabilities: Capability[];
  children: ReactNode;
}) {
  const { held } = useCapabilities();
  if (!capabilities.some((capability) => held.has(capability))) {
    return <Forbidden capability={capabilities[0] ?? 'portal.sign_in'} />;
  }
  return <>{children}</>;
}

export function ForbiddenRoles() {
  const { session } = useSession();
  // The portal origin is configuration, so a deployed console never links to localhost.
  const configuredPortal = import.meta.env.VITE_PORTAL_URL;
  const portalBase =
    typeof configuredPortal === 'string' && configuredPortal.length > 0
      ? configuredPortal.replace(/\/+$/, '')
      : 'http://localhost:5173';
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
