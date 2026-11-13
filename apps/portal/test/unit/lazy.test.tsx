import { render, screen } from '@testing-library/react';
import { Component, Suspense, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { lazyScreen } from '../../src/lazy';

type ReadyModule = { Ready: () => ReactElement };

function Ready(): ReactElement {
  return <p>screen ready</p>;
}

/** The route boundary's job: a chunk that cannot load must not blank the shell. */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? <p>chunk failed</p> : this.props.children;
  }
}

describe('lazyScreen', () => {
  it('loads a named screen export on the first attempt', async () => {
    const loader = vi.fn(async (): Promise<ReadyModule> => ({ Ready }));
    const Screen = lazyScreen(loader, 'Ready');

    render(
      <Suspense fallback={<p>suspended</p>}>
        <Screen />
      </Suspense>,
    );

    expect(await screen.findByText('screen ready')).toBeDefined();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('retries a rejected import once, after the backoff delay', async () => {
    const loader = vi
      .fn<() => Promise<ReadyModule>>()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValue({ Ready });
    const Screen = lazyScreen(loader, 'Ready');

    render(
      <Suspense fallback={<p>suspended</p>}>
        <Screen />
      </Suspense>,
    );

    expect(await screen.findByText('screen ready')).toBeDefined();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('surfaces the second rejection instead of retrying forever', async () => {
    const loader = vi.fn<() => Promise<ReadyModule>>().mockRejectedValue(new Error('chunk gone'));
    const Screen = lazyScreen(loader, 'Ready');

    render(
      <Boundary>
        <Suspense fallback={<p>suspended</p>}>
          <Screen />
        </Suspense>
      </Boundary>,
    );

    expect(await screen.findByText('chunk failed')).toBeDefined();
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
