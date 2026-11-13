import type { ReactNode } from 'react';
import { toProblem } from '@seamnex/api-client';
import { Alert, Button, SkeletonLines } from '@seamnex/ui';
import { RefreshCw } from 'lucide-react';
import { QueryError } from './query-error';

/**
 * The shape `AsyncPanel` reads.
 *
 * It is deliberately structural instead of TanStack's `UseQueryResult`: call sites also hold
 * `useInfiniteQuery` results (whose `data` is an `InfiniteData` envelope) and narrowed hook
 * returns, and every one of them satisfies these five members. `refetch` is typed `() => unknown`
 * for the same reason — a `refetch` that takes optional options, one that returns a promise and one
 * that returns nothing are all assignable, so no call site needs a cast to hand its query over.
 *
 * `isPending` here means "this query has never produced data" in practice, because the panel always
 * checks it together with `data === undefined`. That pairing is what keeps a cached result on
 * screen while the next request is in flight.
 */
export type AsyncQuery<T> = {
  isPending: boolean;
  isError: boolean;
  data: T | undefined;
  error: unknown;
  refetch: () => unknown;
};

export type AsyncPanelProps<T> = {
  query: AsyncQuery<T>;
  /** Rendered while the query has not produced data yet. Defaults to five skeleton lines. */
  loading?: ReactNode;
  /**
   * Accessible name of the loading region. Every screen loads something different, and "Loading"
   * alone announces nothing useful when a page composes several panels.
   */
  loadingLabel?: string;
  /**
   * The screen's own empty copy, for data that is present but says nothing. Returning `null` or
   * `false` means "there is nothing to report", which is the shape the review's example uses
   * (`rows.length === 0 && <EmptyState … />`).
   */
  empty?: (data: T) => ReactNode;
  /**
   * Replaces the whole panel on a failure that left no data behind. Receives the raw error (not a
   * `ProblemDetail`) so a screen can special-case a code — a failed lazy chunk, for instance —
   * and a retry action that is already bound to this query.
   */
  renderError?: (error: unknown, retry: () => void) => ReactNode;
  /** The populated panel. Only called once `data` is defined. */
  children: (data: T) => ReactNode;
};

/**
 * Five lines, because that is the height of the smallest table these panels wrap; a shorter
 * placeholder makes the panel jump when the rows arrive, which is the layout shift the shared
 * primitive is supposed to remove. Hoisted to module scope so a re-render does not allocate a new
 * element for the default.
 */
const DEFAULT_LOADING = <SkeletonLines lines={5} />;

/**
 * One async region: the loading, failure and empty branches for a query-backed panel.
 *
 * Roughly two dozen screens spelled these branches out by hand and the versions disagreed — some
 * gated the content on `isSuccess`, some on `data &&`, some rendered the error *and* the table. Two
 * defects followed from that: a failed background refresh replaced good data with a full error
 * panel (ERR-04), and no branch announced that anything was loading (ERR-03).
 *
 * The order of the branches below is the contract, not an implementation detail:
 *
 * 1. pending with no data      → the loading region;
 * 2. failed with no data       → the fatal error panel;
 * 3. failed *with* data        → a caution banner above the stale content (ERR-04);
 * 4. settled with no data      → the empty copy, or nothing;
 * 5. data that the screen calls empty → the screen's copy;
 * 6. otherwise                 → the screen's content.
 *
 * Two properties are load-bearing:
 *
 * - **No wrapper element.** Screens are composed of `Panel`/`PageHeader` siblings and the console
 *   tests mount whole screens and query by role; an extra `<div>` or `<section>` would add a
 *   landmark and change the layout of every panel it wraps. The degraded branch returns a
 *   fragment for the same reason.
 * - **No `aria-live` of its own.** `Alert` and `QueryError` already own their live-region
 *   semantics, and duplicating them makes a screen reader announce a failure twice. The loading
 *   region is the only a11y surface added here, and it is `role="status"` + `aria-busy`, matching
 *   the route fallback in both apps.
 */
export function AsyncPanel<T>({
  query,
  loading = DEFAULT_LOADING,
  loadingLabel,
  empty,
  renderError,
  children,
}: AsyncPanelProps<T>) {
  const { isPending, isError, data, error } = query;
  // Bound once: branch 2 hands it to `QueryError`, branch 3 to the banner's button, and both
  // discard the promise for the same reason the transport does — an unhandled rejection is not a
  // recovery path.
  const retry = () => void query.refetch();

  // 1. No data and a request running. A *disabled* query (`enabled: false`) is also pending with no
  // data and would show this placeholder forever; `AsyncQuery` has no `fetchStatus` on purpose,
  // because whether a read may run is the screen's decision. A panel gated behind a dialog is
  // mounted with the dialog, not before it.
  if (isPending && data === undefined) {
    return (
      <div role="status" aria-busy="true" aria-label={loadingLabel ?? 'Loading'}>
        {loading}
      </div>
    );
  }

  // 2. Nothing to show and nothing to fall back to: the panel is unusable, so it is replaced.
  if (isError && data === undefined) {
    return renderError ? renderError(error, retry) : <QueryError error={error} onRetry={retry} />;
  }

  // 3. A failed *background* refresh. The cached result is still the last thing the API said, and
  // it is usually still meaningful; replacing the screen with an error panel throws away work the
  // operator was reading. The banner says which data this is and gives the retry that the error
  // panel used to give.
  if (isError && data !== undefined) {
    return (
      <>
        <Alert
          tone="caution"
          // The hand-rolled blocks this replaces wrapped themselves in `p-4`, so the spacing
          // between banner and content was implicit. Keep the gap without reintroducing a wrapper.
          className="mb-3"
          title="Showing the last data that loaded"
          action={
            <Button size="sm" variant="secondary" icon={<RefreshCw />} onClick={retry}>
              Retry
            </Button>
          }
        >
          {toProblem(error).detail}
        </Alert>
        {children(data)}
      </>
    );
  }

  // 4. A settled query that produced no data at all — `enabled: false`, or a hook that resolved to
  // nothing. `undefined as never` is how the absent value reaches a callback typed for `T` without
  // widening `T` to `T | undefined` for every other call site.
  if (data === undefined) {
    return empty ? empty(undefined as never) : null;
  }

  // 5. Present but empty. Most call sites write `empty` as `rows.length === 0 && <EmptyState … />`,
  // and `false` renders nothing — so a boolean is "no empty state", not "an empty state that
  // happens to be blank". Without that check the `&&` form would blank the panel instead of
  // falling through to the children.
  const emptyNode = empty?.(data);
  if (emptyNode !== undefined && emptyNode !== null && typeof emptyNode !== 'boolean') {
    return emptyNode;
  }

  // 6. The populated panel.
  return children(data);
}
