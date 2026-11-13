import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '@seamnex/api-client';
import type * as ApiClient from '@seamnex/api-client';
import { TooltipProvider } from '@seamnex/ui';
import { SessionProvider } from '../../src/session';
import { ProductPage } from '../../src/features/product/ProductPage';

/**
 * The defensive branch the API cannot currently produce: a settled read with no tile.
 *
 * Contract enforcement turns a 200 into a tile, and a non-2xx becomes an error, so "no data and no
 * error" is only reachable when a caller mounts the screen outside a resolved query — a stale chunk
 * after a redeploy, or a future endpoint that answers 204. Covering it here keeps the empty copy
 * honest without inventing a response the mock platform would reject.
 */
vi.mock('@seamnex/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    useProductTile: () => ({
      isPending: false,
      isError: false,
      data: undefined,
      error: null,
      refetch: () => undefined,
    }),
  };
});

describe('product page without a tile', () => {
  it('offers the launcher instead of rendering a half-empty page', () => {
    render(
      <MemoryRouter initialEntries={['/?role=R5']}>
        <SessionProvider>
          <ApiProvider>
            <TooltipProvider>
              <ProductPage />
            </TooltipProvider>
          </ApiProvider>
        </SessionProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText('This application is not available to your role')).toBeDefined();
    expect(screen.getByText(/Unentitled applications are absent from the catalog/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Back to launcher' }).getAttribute('href')).toBe('/');
  });
});
