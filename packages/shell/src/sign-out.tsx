import { useState } from 'react';
import { LogOut, ShieldCheck } from 'lucide-react';
import {
  fetchSession,
  providerLogoutUrl,
  rememberProviderLogout,
  useLogout,
} from '@seamnex/api-client';
import type { LogoutResponse } from '@seamnex/domain';
import { Button, Dialog, InlineNote, SkeletonLines } from '@seamnex/ui';
import { formatDuration, formatRelative } from '@seamnex/utils';
import { QueryError } from './query-error';

/**
 * The shared sign-out surface (FR-3.8).
 *
 * Both applications render it: the portal for its end-user session, the console because an
 * operator holding an administrative session must be able to end it, and `/sign-in` refuses to
 * render while a session exists (`sessionRouting`), so without this control the console has no
 * way out at all. Sign-*in* was already shared (`./sign-in`); keeping sign-*out* in one app meant
 * the residual-session disclosure could drift between two copies of the same rule.
 *
 * The destination half of FR-3.8 (an unauthenticated landing page) remains the recorded scope
 * exception EX-1; `signedOutPath` names where the browser goes once the platform session is gone.
 */
export function SignOutDialog({
  open,
  onOpenChange,
  signedOutPath = '/sign-in',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where to land once the session is terminated. Defaults to the sign-in route. */
  signedOutPath?: string;
}) {
  const logout = useLogout();
  const [result, setResult] = useState<LogoutResponse | null>(null);

  /**
   * Closing after a completed sign-out leaves the application; it does not stay on it.
   *
   * The platform session is already gone, so the screen behind this dialog can only answer `401`.
   * Dismissing with Escape or the backdrop would strand the user on a page that renders the
   * previous identity and fails every request; leaving is the only honest close.
   */
  const close = (next: boolean) => {
    if (!next && result !== null) {
      void leaveFor();
      return;
    }
    if (!next) {
      setResult(null);
      logout.reset();
    }
    onOpenChange(next);
  };

  /**
   * Leaves for the provider's logout endpoint when there is one.
   *
   * The platform session is already gone by the time this runs, so the residual-session report is
   * never skipped — but the provider may still hold its own single-sign-on session, and returning
   * to the sign-in page without ending it would silently sign the same person back in. `GET
   * /auth/session` is anonymous now, which is exactly what makes it a cheap way to read which
   * provider this deployment uses.
   */
  const leaveFor = async (): Promise<void> => {
    const session = await fetchSession().catch(() => null);
    window.location.assign(
      (session === null ? null : providerLogoutUrl(session.auth)) ?? signedOutPath,
    );
  };

  /**
   * Remembers the same destination for the case where nobody presses "Sign in again".
   *
   * The report above is the honest place to leave from, but a person who closes the tab or reloads
   * instead is not making a decision about the provider session — and that session, still alive,
   * re-enters them on the next visit. Writing the URL down lets the sign-in page finish the
   * sign-out the first one started; it is read once there, so this cannot loop.
   */
  const rememberLogout = async (): Promise<void> => {
    const session = await fetchSession().catch(() => null);
    const url = session === null ? null : providerLogoutUrl(session.auth);
    if (url !== null) rememberProviderLogout(url);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={result ? 'Signed out' : 'Sign out of the platform?'}
      description={
        result
          ? // Every dialog needs a description: without one the dialog opens with no context for
            // a screen reader, and Radix reports the missing `aria-describedby` in development.
            'Your platform session has ended. Product sessions that do not support single logout are listed below with their expected lifetime.'
          : // The provider confirms before it ends its own session (the platform holds no id_token
            // to hint with), which is one more click than a user expects from a "Sign out" button.
            // Saying so here is cheaper than an unexplained detour to the identity provider.
            'This ends your platform session. Your identity provider will ask you to confirm before it ends its own session; products with single logout are signed out too, and the rest keep their own session for a bounded time.'
      }
      footer={
        result ? (
          // The cookie is gone; staying on an authenticated screen would only produce a 401. The
          // link goes through the provider's logout when this deployment has one, so the next
          // visit does not silently re-enter as the same person.
          <Button variant="primary" onClick={() => void leaveFor()}>
            Sign in again
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Stay signed in
            </Button>
            <Button
              variant="primary"
              icon={<LogOut />}
              disabled={logout.isPending}
              onClick={() => {
                logout.mutate(undefined, {
                  onSuccess: (data) => {
                    setResult(data);
                    void rememberLogout();
                  },
                });
              }}
            >
              {logout.isPending ? 'Signing out…' : 'Sign out'}
            </Button>
          </>
        )
      }
    >
      {logout.isError ? <QueryError error={logout.error} compact /> : null}

      {logout.isPending ? <SkeletonLines lines={3} /> : null}

      {result ? (
        <div className="space-y-3">
          <p className="text-body leading-relaxed text-text">{result.statement}</p>
          {result.residualSessions.length > 0 ? (
            <ul className="divide-y divide-line rounded-sm border border-line">
              {result.residualSessions.map((session) => (
                <li
                  key={session.instanceId}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="text-body text-text">{session.product}</span>
                  <span className="font-mono text-micro text-muted">
                    {/*
                      FR-3.8 / NB-4: never invent a lifetime the platform has not verified. The
                      number is an integration *estimate* — the maximum lifetime the product was
                      verified to allow — not a session the platform can see. Printing it as
                      "up to 8 h remaining" claimed knowledge of a session that may not exist at
                      all, so the sentence names what the number is, and when it was verified.
                    */}
                    {session.maxRemainingMinutes === null
                      ? 'lifetime not verified'
                      : `≤ ${formatDuration(session.maxRemainingMinutes)} expected${
                          session.verifiedAt === null
                            ? ''
                            : `, verified ${formatRelative(session.verifiedAt)}`
                        }`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="flex items-center gap-2 text-body text-muted">
              <ShieldCheck className="size-4 text-success" aria-hidden /> No product sessions
              remain.
            </p>
          )}
          <InlineNote>
            Session lifetimes come from each product's verified integration metadata. The platform
            never stores a product password.
          </InlineNote>
        </div>
      ) : null}
    </Dialog>
  );
}
