import { Link } from 'react-router';
import { SearchX } from 'lucide-react';
import { buttonVariants, EmptyState, Panel, PanelHeader } from '@seamnex/ui';

/**
 * The 404 shares the 403's shape — a panel with a header — so both dead ends look like part of
 * the portal. It used to be a bare panel with no heading at all, which read as a stray card.
 */
export function NotFoundPage() {
  return (
    <Panel className="mx-auto mt-6 max-w-2xl">
      <PanelHeader headingLevel={1} eyebrow="404 · not found" title="Page not found" />
      <EmptyState
        icon={<SearchX className="size-5" />}
        title="The address does not match a portal screen"
        description="It may have been moved, or the link may be incomplete. The launcher lists every application your role can reach."
        // The link is styled as the button: wrapping a real `<button>` in an anchor gives the
        // page two focus stops for one destination (and invalid nested interactive markup).
        action={
          <Link to="/" className={buttonVariants({ variant: 'primary' })}>
            Back to launcher
          </Link>
        }
      />
    </Panel>
  );
}
