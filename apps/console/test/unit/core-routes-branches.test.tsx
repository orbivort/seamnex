import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * Route-level behaviour: the panel an operator lands on when the address matches nothing, and the
 * chunk prefetch that runs ahead of a navigation.
 *
 * The prefetch is verified through a chunk that fails once. A prefetch is never awaited and never
 * reported, but it must release the route it warmed: otherwise one transient failure during a
 * deployment would leave that section cold for the rest of the session, because the click would no
 * longer warm anything.
 */
const chunk = vi.hoisted(() => ({ attempts: 0 }));

vi.mock('../../src/features/registry/RegistryPage', () => {
  chunk.attempts += 1;
  if (chunk.attempts === 1) throw new Error('the chunk was replaced by a newer deployment');
  return { RegistryPage: () => null };
});

describe('route chunk prefetching', () => {
  it('lets a later hover warm a route whose chunk failed the first time', async () => {
    const { preloadRoute } = await import('../../src/lazy-routes');
    expect(chunk.attempts).toBe(0);

    // The failure is swallowed: a prefetch that cannot load is the navigation's problem, not the
    // operator's, so nothing is thrown into the page.
    expect(() => preloadRoute('/registry')).not.toThrow();
    await waitFor(() => expect(chunk.attempts).toBe(1));

    // …but the route is released, so the next hover tries again instead of being a silent no-op.
    preloadRoute('/registry');
    await waitFor(() => expect(chunk.attempts).toBe(2));
  });
});

describe('console not-found panel', () => {
  it('takes the operator back to the previous screen instead of dead-ending', async () => {
    // An address that matches no console section still renders inside the shell, and the way out is
    // history rather than a guess at the right section.
    openAs('R1', '/no-such-console-section');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);

    render(<App />);

    expect(await screen.findByText('Console page not found')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));

    expect(back).toHaveBeenCalledTimes(1);
    // The shell survives the click: the sidebar is still there to navigate with.
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0);
    expect(screen.getByText('Console page not found')).toBeDefined();
    back.mockRestore();
  });
});
