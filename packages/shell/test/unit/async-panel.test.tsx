import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@seamnex/api-client';
import type { ProblemDetail } from '@seamnex/domain';
import { AsyncPanel, type AsyncQuery } from '../../src/async-panel';

/**
 * `AsyncPanel` is a branch table, and the order of its branches is the contract (ERR-03/ERR-04):
 * a failed *background* refresh must keep the cached rows on screen, while a failure with nothing
 * cached replaces the panel. Every case below pins one row of that table.
 */
const unavailable: ProblemDetail = {
  type: 'https://platform.seamnex.local/problems/unavailable',
  title: 'The platform API is unavailable',
  status: 503,
  detail: 'The instance list could not be loaded.',
  code: 'UNAVAILABLE',
  fieldErrors: [],
  remediation: 'Retry in a moment.',
};

function makeQuery<T>(overrides: Partial<AsyncQuery<T>> = {}): AsyncQuery<T> {
  return {
    isPending: false,
    isError: false,
    data: undefined,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  };
}

describe('AsyncPanel', () => {
  it('announces a loading region with the default label and five skeleton lines', () => {
    const { container } = render(
      <AsyncPanel query={makeQuery<string[]>({ isPending: true })}>
        {(rows) => <p>{rows.join(',')}</p>}
      </AsyncPanel>,
    );

    const region = screen.getByRole('status', { name: 'Loading' });
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelectorAll('.h-3')).toHaveLength(5);
  });

  it('uses the screen’s own label and placeholder when it supplies them', () => {
    render(
      <AsyncPanel
        query={makeQuery({ isPending: true })}
        loadingLabel="Loading instances"
        loading={<p>one moment</p>}
      >
        {() => <p>never</p>}
      </AsyncPanel>,
    );

    const region = screen.getByRole('status', { name: 'Loading instances' });
    expect(region.textContent).toContain('one moment');
  });

  it('keeps the cached rows on screen while the first request is in flight', () => {
    render(
      <AsyncPanel query={makeQuery({ isPending: true, data: ['cached'] })}>
        {(rows) => <p>{rows.join(',')}</p>}
      </AsyncPanel>,
    );

    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
    expect(screen.getByText('cached')).toBeDefined();
  });

  it('replaces the panel with a problem when the first load fails', () => {
    const query = makeQuery<string[]>({ isError: true, error: new Error('offline') });
    render(<AsyncPanel query={query}>{() => <p>never</p>}</AsyncPanel>);

    expect(screen.getByText('The platform API could not be reached')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });

  it('lets the screen replace the failure panel entirely', () => {
    const query = makeQuery<string[]>({ isError: true, error: new Error('chunk failed') });
    const renderError = vi.fn((error: unknown, retry: () => void) => (
      <button type="button" onClick={retry}>
        {error instanceof Error ? error.message : 'unknown'}
      </button>
    ));

    render(
      <AsyncPanel query={query} renderError={renderError}>
        {() => <p>never</p>}
      </AsyncPanel>,
    );

    expect(renderError).toHaveBeenCalledTimes(1);
    expect(renderError.mock.calls[0]?.[0]).toBe(query.error);
    fireEvent.click(screen.getByRole('button', { name: 'chunk failed' }));
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps stale data behind a caution banner when a refresh fails', () => {
    const query = makeQuery<string[]>({
      isError: true,
      error: new ApiError(unavailable),
      data: ['stale'],
    });
    render(
      <AsyncPanel query={query} renderError={() => <p>never</p>}>
        {(rows) => <p>{rows.join(',')}</p>}
      </AsyncPanel>,
    );

    expect(screen.getByText('Showing the last data that loaded')).toBeDefined();
    expect(screen.getByText('The instance list could not be loaded.')).toBeDefined();
    expect(screen.getByText('stale')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });

  it('renders the screen’s empty copy for a settled query with no data', () => {
    const empty = vi.fn(() => <p>nothing yet</p>);
    render(
      <AsyncPanel query={makeQuery()} empty={empty}>
        {() => <p>never</p>}
      </AsyncPanel>,
    );

    expect(screen.getByText('nothing yet')).toBeDefined();
    expect(empty).toHaveBeenCalledWith(undefined);
  });

  it('renders nothing for a settled query with no data and no empty copy', () => {
    const { container } = render(<AsyncPanel query={makeQuery()}>{() => <p>never</p>}</AsyncPanel>);

    expect(container.textContent).toBe('');
  });

  it.each([
    ['false', false],
    ['null', null],
    ['undefined', undefined],
  ])('falls through to the content when the empty copy returns %s', (_label, emptyNode) => {
    render(
      <AsyncPanel query={makeQuery({ data: ['row'] })} empty={() => emptyNode}>
        {(rows) => <p>{rows.join(',')}</p>}
      </AsyncPanel>,
    );

    expect(screen.getByText('row')).toBeDefined();
  });

  it('prefers the empty copy over the content when the screen returns a node', () => {
    const children = vi.fn((rows: string[]) => <p>{rows.join(',')}</p>);
    render(
      <AsyncPanel query={makeQuery({ data: ['row'] })} empty={() => <p>no rows match</p>}>
        {children}
      </AsyncPanel>,
    );

    expect(screen.getByText('no rows match')).toBeDefined();
    expect(children).not.toHaveBeenCalled();
  });

  it('renders the content when there is data and no empty copy at all', () => {
    render(
      <AsyncPanel query={makeQuery({ data: ['row'] })}>
        {(rows) => <p>{rows.join(',')}</p>}
      </AsyncPanel>,
    );

    expect(screen.getByText('row')).toBeDefined();
  });
});
