import { Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@seamnex/ui';
import { lazyScreen } from '../../src/lazy';

/**
 * `React.lazy` caches the first rejection, so the retry has to live inside the loader. A screen
 * whose chunk was replaced by a deployment must survive one failed import and fail visibly — never
 * silently — when the second attempt fails too.
 */
describe('lazy screen loader', () => {
  it('renders the named export once the module resolves', async () => {
    const Screen = () => <p>Overview loaded</p>;
    const Lazy = lazyScreen(async () => ({ Overview: Screen }), 'Overview');

    render(
      <Suspense fallback={<p>loading</p>}>
        <Lazy />
      </Suspense>,
    );

    expect(await screen.findByText('Overview loaded')).toBeDefined();
  });

  it('retries a transient import failure once', async () => {
    const Screen = () => <p>Recovered screen</p>;
    const loader = vi
      .fn<() => Promise<{ Overview: typeof Screen }>>()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({ Overview: Screen });
    const Lazy = lazyScreen(loader, 'Overview');

    render(
      <Suspense fallback={<p>loading</p>}>
        <Lazy />
      </Suspense>,
    );

    expect(
      await screen.findByText('Recovered screen', undefined, { timeout: 5_000 }),
    ).toBeDefined();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('surfaces a permanent failure to the nearest boundary', async () => {
    const loader = vi
      .fn<() => Promise<{ Overview: () => React.JSX.Element }>>()
      .mockRejectedValue(new Error('chunk gone'));
    const Lazy = lazyScreen(loader, 'Overview');

    render(
      <ErrorBoundary fallback={() => <p>Screen unavailable</p>}>
        <Suspense fallback={<p>loading</p>}>
          <Lazy />
        </Suspense>
      </ErrorBoundary>,
    );

    expect(
      await screen.findByText('Screen unavailable', undefined, { timeout: 5_000 }),
    ).toBeDefined();
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
