import { useEffect, useState, type ReactNode } from 'react';
import { toProblem } from '@seamnex/api-client';
import type { SessionState } from '@seamnex/shell';
import { ErrorState, Splash } from '@seamnex/ui';
import { mockPlatformReady, resolveSession } from './bootstrap';

type GateState =
  | { readonly kind: 'starting' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * Holds the application back until the platform it talks to is ready, without holding back the
 * document.
 *
 * Two things are awaited, in order: the mock platform (development and demo builds only) and the
 * server's session (live builds only). Both used to be awaited *before* `createRoot`, which left
 * the page blank for a whole round trip; now the splash paints immediately and the same ordering
 * is enforced one level down, before any query can mount.
 *
 * Rendering the tree only once the session is settled matters for more than latency: the session
 * kit reads the asserted role from storage during its first render, so mounting earlier would
 * render one role and fetch as another.
 */
export function SessionGate({
  initialSession,
  appName,
  children,
}: {
  initialSession: SessionState;
  appName: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<GateState>({ kind: 'starting' });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await mockPlatformReady();
        await resolveSession(initialSession);
        if (active) setState({ kind: 'ready' });
      } catch (error) {
        if (active) setState({ kind: 'failed', error });
      }
    })();
    return () => {
      active = false;
    };
  }, [initialSession]);

  if (state.kind === 'starting') {
    return <Splash appName={appName} label="Preparing your session…" />;
  }

  if (state.kind === 'failed') {
    return (
      <div className="mx-auto max-w-xl p-6">
        <ErrorState problem={toProblem(state.error)} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  return <>{children}</>;
}
