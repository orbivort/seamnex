import { useEffect, useState } from 'react';
import { onUnauthorized } from '@seamnex/api-client';
import type { ProblemDetail } from '@seamnex/domain';
import { Alert, Button } from '@seamnex/ui';

/**
 * A `401` cannot be repaired inside the app: the platform has no local credential store
 * (FR-3.2), so the only honest response is to say that the session lapsed and send the user to
 * the sign-in destination with the interrupted location preserved (CL-01).
 *
 * Both layouts import this component, but only one instance is mounted at a time; the redirect is
 * therefore issued once, after a short beat so the notice is legible.
 */
export function UnauthorizedNotice() {
  const [problem, setProblem] = useState<ProblemDetail | null>(null);

  useEffect(() => onUnauthorized(setProblem), []);

  useEffect(() => {
    if (problem === null) return;
    // Already on the sign-in screen: the flow owns the error region there.
    if (window.location.pathname === '/sign-in') return;
    const timer = setTimeout(() => {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/sign-in?next=${encodeURIComponent(next)}`);
    }, 1_400);
    return () => clearTimeout(timer);
  }, [problem]);

  if (problem === null) return null;

  return (
    <div className="px-4 pt-3">
      <Alert
        tone="caution"
        title="Your session is no longer authorised"
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const next = `${window.location.pathname}${window.location.search}`;
              window.location.assign(`/sign-in?next=${encodeURIComponent(next)}`);
            }}
          >
            Sign in
          </Button>
        }
      >
        {problem.detail} {problem.remediation}
      </Alert>
    </div>
  );
}
