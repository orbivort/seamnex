import { useCallback, useEffect, useRef, useState } from 'react';
import {
  beginSignIn,
  completeSignIn,
  fetchSession,
  safeNextPath,
  takeProviderLogout,
  toProblem,
  type CallbackFailure,
} from '@seamnex/api-client';
import type { AuthProviderConfig, AuthSession, PlatformRole } from '@seamnex/domain';
import { Alert, BrandLockup, Button, Panel } from '@seamnex/ui';
import { StubSignInForm, readInitialRole } from './sign-in-stub';

/**
 * The shared sign-in surface (CL-01, deliverable 3.5; ADR-BE-14).
 *
 * The screen renders whatever the *server* says the provider is. In provider mode it is one
 * action: leave for the identity provider and come back. In development it is the identity picker,
 * labelled as such so it can never be mistaken for the production path.
 *
 * Nothing credential-like is held here. The PKCE verifier and the `state` correlation value live in
 * `sessionStorage` for the duration of one round trip (see `@seamnex/api-client`), and the session
 * itself is an `HttpOnly` cookie this code cannot read.
 */

type ScreenState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly auth: AuthProviderConfig; readonly signedOut: boolean }
  | {
      readonly kind: 'busy';
      readonly auth: AuthProviderConfig;
      readonly step: 'redirecting' | 'finishing';
    }
  | {
      readonly kind: 'failed';
      readonly auth: AuthProviderConfig;
      readonly title: string;
      readonly detail: string;
      readonly recovery: 'retry' | 'switch-account';
    }
  /** The API itself did not answer; nothing can be decided about the provider. */
  | { readonly kind: 'offline'; readonly detail: string };

export function SignInPage({ appName }: { appName: string }) {
  const params = new URLSearchParams(window.location.search);
  const next = safeNextPath(params.get('next'));
  const initialRole = readInitialRole(params.get('role'));
  const signedOut = params.get('signed-out') === '1';

  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const alertRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        /*
         * A sign-out that was not carried through to the provider.
         *
         * The platform session is already gone when this page is reached, but the provider may
         * still hold its own — and its presence is exactly what makes the next sign-in silent. The
         * sign-out dialog records this destination when it completes, so closing the tab or
         * reloading between the two clicks finishes the job here instead of leaving the provider
         * session alive. Reading it also removes it: one completion, never a loop.
         */
        const owed = takeProviderLogout();
        if (owed !== null) {
          window.location.assign(owed);
          return;
        }

        const session = await fetchSession();
        if (!active) return;
        // A signed-in visitor who reached this page directly is sent on rather than shown a card;
        // `sessionRouting` usually does this before render, but a bookmark bypasses it.
        if (session.authenticated) {
          navigate(next, session);
          return;
        }

        const auth = session.auth;
        if (!hasCallback(window.location.search)) {
          setState({ kind: 'ready', auth, signedOut });
          return;
        }

        setState({ kind: 'busy', auth, step: 'finishing' });
        const outcome = await completeSignIn(auth, window.location.search);
        if (!active) return;
        if (outcome.kind === 'signed-in') {
          navigate(outcome.next, outcome.session);
          return;
        }
        if (outcome.kind === 'none') {
          setState({ kind: 'ready', auth, signedOut: false });
          return;
        }
        setState({ kind: 'failed', auth, ...copyFor(outcome.reason, outcome.detail) });
      } catch (error) {
        if (active) setState({ kind: 'offline', detail: toProblem(error).detail });
      }
    })();
    return () => {
      active = false;
    };
  }, [next, signedOut]);

  const start = useCallback(
    async (auth: AuthProviderConfig, force: boolean) => {
      const url = await beginSignIn(auth, next, { force });
      if (url === null) return;
      setState({ kind: 'busy', auth, step: 'redirecting' });
      // A full navigation: the provider must own this tab's address bar, and the cookie it sets on
      // return belongs to the whole origin.
      window.location.assign(url);
    },
    [next],
  );

  useEffect(() => {
    if (state.kind === 'failed') alertRef.current?.focus();
  }, [state.kind]);

  const provider = state.kind === 'loading' || state.kind === 'offline' ? null : state.auth;

  return (
    <div className="relative flex min-h-screen flex-col bg-paper">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(1200px_520px_at_50%_-12%,rgb(20_119_106/10%),transparent_70%)]"
      />
      <header className="relative flex items-center justify-between gap-3 px-5 py-5 sm:px-8">
        {/* The unauthenticated screen is the product's first impression, so it carries the same
            lockup as the signed-in chrome: the mark does not disappear at the door. `md` is the
            larger wordmark size; the mark stays at its invariant 32px. */}
        <BrandLockup size="md" />
        <span className="label-caps shrink-0 rounded-sm border border-line bg-panel/70 px-2 py-1 text-muted">
          {provider?.provider === 'oidc' ? 'Single sign-on' : 'Development identity'}
        </span>
      </header>

      <main className="relative flex flex-1 items-start justify-center px-5 pb-16 pt-6 sm:items-center sm:pt-0">
        <div className="w-full max-w-[var(--shell-auth-measure)]">
          <Panel className="border-line-strong shadow-overlay">
            <div className="p-6 sm:p-7">
              <p className="label-caps text-link">{appName}</p>
              <h1 className="mt-2 font-display text-display font-semibold text-text">
                {state.kind === 'busy'
                  ? state.step === 'redirecting'
                    ? 'Taking you to your provider'
                    : 'Finishing sign-in'
                  : 'Sign in to continue'}
              </h1>
              <p className="mt-2 text-body leading-relaxed text-muted">
                {state.kind === 'busy'
                  ? 'You will be returned to this page. Nothing is stored in this browser beyond the pending request.'
                  : 'The platform has no local password. Your identity provider confirms who you are, and the platform issues its own session.'}
              </p>

              {/* The `Alert`s below own their live-region semantics; a second wrapper only
                  duplicates the announcement. */}
              <div className="mt-4">
                {signedOut && state.kind === 'ready' ? (
                  <Alert tone="neutral" title="Signed out">
                    Your platform session has ended. Signing in again starts a new one.
                  </Alert>
                ) : null}
                {state.kind === 'failed' ? (
                  <div ref={alertRef} tabIndex={-1} className="outline-none">
                    <Alert tone="danger" title={state.title}>
                      {state.detail}
                    </Alert>
                  </div>
                ) : null}
                {state.kind === 'offline' ? (
                  <Alert tone="danger" title="The platform API could not be reached">
                    {state.detail}
                  </Alert>
                ) : null}
              </div>

              <div className="mt-5">
                <Body
                  state={state}
                  initialRole={initialRole}
                  onStart={start}
                  onSession={(session) => navigate(next, session)}
                />
              </div>

              <p className="mt-5 border-t border-line pt-4 text-meta leading-relaxed text-faint">
                A refused sign-in never creates a session and is recorded in the audit trail.
              </p>
            </div>
          </Panel>

          <p className="mt-4 text-center text-meta text-muted">
            Need access? Request it from the platform owner.
          </p>
        </div>
      </main>
    </div>
  );
}

function Body({
  state,
  initialRole,
  onStart,
  onSession,
}: {
  state: ScreenState;
  initialRole: PlatformRole;
  onStart: (auth: AuthProviderConfig, force: boolean) => Promise<void>;
  onSession: (session: AuthSession) => void;
}) {
  if (state.kind === 'loading') return <Progress label="Preparing sign-in…" />;

  if (state.kind === 'busy') {
    return (
      <Progress
        label={
          state.step === 'redirecting'
            ? 'Waiting for your identity provider…'
            : 'Checking the response…'
        }
      />
    );
  }

  if (state.kind === 'offline') {
    return (
      <Button variant="secondary" size="lg" block onClick={() => window.location.reload()}>
        Try again
      </Button>
    );
  }

  if (state.kind === 'failed') {
    return state.recovery === 'retry' ? (
      <Button
        variant="primary"
        size="lg"
        block
        onClick={() => void onStart(state.auth, false)}
        trailing={<span aria-hidden>→</span>}
      >
        Try again
      </Button>
    ) : (
      <Button
        variant="primary"
        size="lg"
        block
        onClick={() => void onStart(state.auth, true)}
        trailing={<span aria-hidden>→</span>}
      >
        Use a different account
      </Button>
    );
  }

  if (state.auth.provider === 'oidc') {
    return (
      <div className="space-y-3">
        <Button
          variant="primary"
          size="lg"
          block
          className="group"
          onClick={() => void onStart(state.auth, false)}
          trailing={
            <span
              aria-hidden
              className="transition-transform duration-150 group-hover:translate-x-0.5"
            >
              →
            </span>
          }
        >
          Continue with Keycloak
        </Button>
        <Button variant="ghost" size="md" block onClick={() => void onStart(state.auth, true)}>
          Use a different account
        </Button>
      </div>
    );
  }

  return (
    <details open>
      <summary className="cursor-pointer list-none rounded-sm border border-line bg-panel-soft/60 px-3 py-2 text-meta font-semibold text-muted transition-colors duration-150 hover:text-text">
        Development sign-in
      </summary>
      <div className="mt-3 rounded-sm border border-line/70 bg-paper-deep/40 p-3">
        <StubSignInForm initialRole={initialRole} onSession={onSession} />
      </div>
    </details>
  );
}

/**
 * A thin indeterminate bar rather than a spinner: the wait is a network round trip with no
 * progress to report, and a determinate-looking indicator would be a lie.
 */
function Progress({ label }: { label: string }) {
  return (
    <div className="space-y-3 py-1" role="status" aria-live="polite">
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-line">
        <div className="h-full w-1/3 rounded-full bg-primary motion-safe:animate-pulse" />
      </div>
      <p className="label-caps text-center text-muted">{label}</p>
    </div>
  );
}

function hasCallback(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has('code') || params.has('error');
}

/**
 * One message per failure, and exactly one way out of it. "Try again" restarts the flow; an account
 * without a role cannot fix itself by retrying, so that case offers a different account instead.
 */
function copyFor(
  reason: CallbackFailure,
  detail: string,
): { title: string; detail: string; recovery: 'retry' | 'switch-account' } {
  switch (reason) {
    case 'cancelled':
      return {
        title: 'Sign-in was cancelled',
        detail: 'Nothing changed. Try again when you are ready, or use a different account.',
        recovery: 'retry',
      };
    case 'state-mismatch':
      return {
        title: 'That sign-in response is not valid',
        detail:
          'The identity provider returned a response this browser did not request, so it was ignored.',
        recovery: 'retry',
      };
    case 'expired':
      return {
        title: 'This sign-in attempt expired',
        detail: 'Start again from this page; the previous attempt can no longer be completed.',
        recovery: 'retry',
      };
    case 'mfa-required':
      return {
        title: 'A second factor is required',
        detail:
          'This account must present a second factor at the identity provider before a session can be created.',
        recovery: 'retry',
      };
    case 'no-role':
      return {
        title: 'That account has no platform role',
        detail,
        recovery: 'switch-account',
      };
    case 'provider-unavailable':
      return {
        title: 'The identity provider is unreachable',
        detail,
        recovery: 'retry',
      };
    default:
      return { title: 'Sign-in could not be completed', detail, recovery: 'retry' };
  }
}

/**
 * A full navigation, not a router push: the cookie is set and every cached response must rebuild.
 *
 * `?role=` is a development affordance and nothing else. Under a live provider the role is asserted
 * by the identity provider and read from the session, so carrying it in the URL was a leftover from
 * the stub — it made the launcher read `/?role=R5` and suggested the role had come from the query
 * string. It is appended only for the stub, which is the one provider that reads it.
 */
function navigate(next: string, session: AuthSession): void {
  const target = new URL(next, window.location.origin);
  if (session.auth.provider === 'stub' && session.roles[0] !== undefined) {
    target.searchParams.set('role', session.roles[0]);
  }
  window.location.replace(`${target.pathname}${target.search}`);
}
