import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, isChunkLoadError } from '../../../src/primitives/ErrorBoundary';

function Throwing({ message = 'Row 4 is malformed' }: { message?: string }): ReactNode {
  throw new Error(message);
}

/**
 * A route-level guard. Two decisions are pinned: a stale-chunk rejection is not a render bug and
 * must offer a reload rather than a retry that re-throws the memoised rejection, and a boundary
 * whose reset keys changed must release a caught error so navigation is not stuck on it.
 */
describe('isChunkLoadError', () => {
  it("recognises each engine's phrasing of a vanished chunk", () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: /x.js'))).toBe(
      true,
    );
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error('nope'), { name: 'ChunkLoadError' }))).toBe(
      true,
    );
  });

  it('rejects a render error and a non-error throw', () => {
    expect(isChunkLoadError(new Error('row 4 is malformed'))).toBe(false);
    expect(isChunkLoadError('dynamically imported module')).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React and the boundary both report to the console; the assertions below are the signal.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders its children while nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>Intact</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Intact')).toBeDefined();
  });

  it('replaces a failed subtree with a retryable error state', () => {
    render(
      <ErrorBoundary>
        <Throwing />
      </ErrorBoundary>,
    );
    expect(screen.getByText('This screen failed to render')).toBeDefined();
    expect(screen.getByText('Row 4 is malformed')).toBeDefined();
    expect(screen.getByText('UI_RENDER_ERROR · HTTP 500')).toBeDefined();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeDefined();
  });

  it('uses a caller title for every failure', () => {
    render(
      <ErrorBoundary title="Instances could not load">
        <Throwing />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Instances could not load')).toBeDefined();
  });

  it('treats a vanished chunk as a reload, not a retry', () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    });
    try {
      render(
        <ErrorBoundary>
          <Throwing message="Failed to fetch dynamically imported module: /assets/Page-abc.js" />
        </ErrorBoundary>,
      );
      expect(screen.getByText('This screen could not be loaded')).toBeDefined();
      expect(screen.getByText('CHUNK_LOAD_FAILED · HTTP 503')).toBeDefined();
      fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('wraps a non-Error throw so the panel still has a message', () => {
    function ThrowString(): ReactNode {
      throw 'disk full';
    }
    render(
      <ErrorBoundary>
        <ThrowString />
      </ErrorBoundary>,
    );
    expect(screen.getByText('disk full')).toBeDefined();
  });

  it('lets a caller replace the panel and drive the reset', () => {
    const onReset = vi.fn();
    render(
      <ErrorBoundary
        onReset={onReset}
        fallback={(error, reset) => (
          <button type="button" onClick={reset}>
            {`dismiss ${error.message}`}
          </button>
        )}
      >
        <Throwing />
      </ErrorBoundary>,
    );
    const button = screen.getByRole('button', { name: 'dismiss Row 4 is malformed' });
    fireEvent.click(button);

    expect(onReset).toHaveBeenCalledTimes(1);
    // The children throw again on the reset render, so the fallback comes back with a new tree.
    expect(screen.getByRole('button', { name: 'dismiss Row 4 is malformed' })).toBeDefined();
  });

  it('releases a caught error when the reset keys change', () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={['/instances']}>
        <Throwing />
      </ErrorBoundary>,
    );
    expect(screen.getByText('This screen failed to render')).toBeDefined();

    rerender(
      <ErrorBoundary resetKeys={['/instances', 'inst-crm']}>
        <p>Intact</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Intact')).toBeDefined();
  });

  it('releases a caught error when the keys first appear', () => {
    const { rerender } = render(
      <ErrorBoundary>
        <Throwing />
      </ErrorBoundary>,
    );
    expect(screen.getByText('This screen failed to render')).toBeDefined();

    rerender(
      <ErrorBoundary resetKeys={['/instances']}>
        <p>Intact</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Intact')).toBeDefined();
  });

  it('releases a caught error when the keys disappear', () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={['/instances']}>
        <Throwing />
      </ErrorBoundary>,
    );
    rerender(
      <ErrorBoundary>
        <p>Intact</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Intact')).toBeDefined();
  });

  it('stays put while the keys are equal, whether shared or rebuilt', () => {
    const keys = ['/instances'] as const;
    const { rerender } = render(
      <ErrorBoundary resetKeys={keys}>
        <Throwing />
      </ErrorBoundary>,
    );
    expect(screen.getByText('This screen failed to render')).toBeDefined();

    // Same reference: the update must not even compare.
    rerender(
      <ErrorBoundary resetKeys={keys}>
        <Throwing />
      </ErrorBoundary>,
    );
    expect(screen.getByText('This screen failed to render')).toBeDefined();

    // A rebuilt array with the same contents is not a navigation either.
    rerender(
      <ErrorBoundary resetKeys={['/instances']}>
        <Throwing />
      </ErrorBoundary>,
    );
    expect(screen.getByText('This screen failed to render')).toBeDefined();
  });

  it('reports the failure with its component stack', () => {
    render(
      <ErrorBoundary>
        <Throwing />
      </ErrorBoundary>,
    );
    const calls = vi.mocked(console.error).mock.calls;
    const reported = calls.find((call) => call[0] === 'Unhandled UI error');
    expect(reported).toBeDefined();
    expect(reported?.[1]).toBeInstanceOf(Error);
  });
});
