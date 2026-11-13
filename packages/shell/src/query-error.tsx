import { toProblem } from '@seamnex/api-client';
import { ErrorState } from '@seamnex/ui';

/**
 * Renders any query or mutation failure as a problem panel.
 *
 * `toProblem` synthesises a problem for network errors, timeouts and unexpected
 * exceptions, so there is no branch in which the screen silently renders nothing.
 */
export function QueryError({
  error,
  onRetry,
  compact,
}: {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <ErrorState
      problem={toProblem(error)}
      {...(onRetry ? { onRetry } : {})}
      {...(compact === undefined ? {} : { compact })}
    />
  );
}
