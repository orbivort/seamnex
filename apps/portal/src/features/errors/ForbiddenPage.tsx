import { Link } from 'react-router';
import { Lock } from 'lucide-react';
import { ROLE_LABELS } from '@seamnex/domain';
import { buttonVariants, EmptyState, Panel, PanelHeader } from '@seamnex/ui';
import { useSession } from '../../session';

export function ForbiddenPage() {
  const { session } = useSession();
  return (
    <Panel className="mx-auto mt-6 max-w-2xl">
      <PanelHeader
        headingLevel={1}
        eyebrow="403 · denied by default"
        title="This surface is not available to your role"
      />
      <div className="p-6">
        <EmptyState
          icon={<Lock className="size-5" />}
          title={`${session.role} · ${ROLE_LABELS[session.role].name}`}
          description={ROLE_LABELS[session.role].description}
          action={
            <Link to="/" className={buttonVariants({ variant: 'primary' })}>
              Back to launcher
            </Link>
          }
        />
        <p className="mt-2 text-center text-meta text-faint">
          Every API call and UI route is authorised server-side against the capability matrix. The
          portal does not rely on hiding links alone.
        </p>
      </div>
    </Panel>
  );
}
