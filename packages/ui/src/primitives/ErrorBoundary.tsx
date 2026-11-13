import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from './Feedback';

type ErrorBoundaryProps = {
  children: ReactNode;
  /** Shown instead of the failed subtree. */
  title?: string;
  onReset?: () => void;
  /**
   * Values identifying the current view (a route path, an entry key). When one changes, a caught
   * error is discarded: navigating away from a failed screen must not leave the boundary stuck on
   * it, which is what a boundary without reset keys does.
   */
  resetKeys?: readonly unknown[];
  /** Replaces the built-in panel; `reset` clears the error and re-renders the children. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type ErrorBoundaryState = { error: Error | null };

/**
 * A deployment that replaces every hashed chunk turns an open tab's next `import()` into a
 * rejection. That is not a render bug and it cannot be retried in place — the module the old
 * page is asking for no longer exists — so it earns its own message and a reload, instead of a
 * "Retry" button that re-throws the memoised rejection forever.
 */
const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|ChunkLoadError/i;

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return CHUNK_ERROR.test(error.message) || CHUNK_ERROR.test(error.name);
}

function keysChanged(previous?: readonly unknown[], next?: readonly unknown[]): boolean {
  if (previous === next) return false;
  if (previous === undefined || next === undefined) return true;
  if (previous.length !== next.length) return true;
  return previous.some((value, index) => !Object.is(value, next[index]));
}

/**
 * Route-level guard. Without one, a render throw in any screen blanks the whole shell;
 * with one, the navigation stays usable and the operator sees what failed.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    // Guarded on `error`: the reset below triggers another update, which must not loop.
    if (this.state.error === null) return;
    if (!keysChanged(previous.resetKeys, this.props.resetKeys)) return;
    this.setState({ error: null });
  }

  private reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    const chunk = isChunkLoadError(error);
    return (
      <div className="p-4">
        <ErrorState
          problem={{
            type: 'about:blank',
            title:
              this.props.title ??
              (chunk ? 'This screen could not be loaded' : 'This screen failed to render'),
            status: chunk ? 503 : 500,
            detail: chunk
              ? 'A newer version of the console was published while this tab was open, so this screen is no longer available at this address.'
              : error.message,
            code: chunk ? 'CHUNK_LOAD_FAILED' : 'UI_RENDER_ERROR',
            fieldErrors: [],
            remediation: chunk
              ? 'Reload the page to fetch the current version. Nothing you have saved is affected.'
              : 'Retry the screen. If it fails again, reload the page and report the console output with the route you were on.',
          }}
          // A rejected chunk cannot be retried in place: the module is gone. Reload instead.
          onRetry={chunk ? () => window.location.reload() : this.reset}
        />
      </div>
    );
  }
}
