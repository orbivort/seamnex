import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app';
import { openAs } from '../helpers';

describe('portal error surfaces', () => {
  it('explains a forbidden surface with the current role', async () => {
    openAs('R2', 'degraded', '/forbidden');
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'This surface is not available to your role' }),
    ).toBeDefined();
    expect(screen.getByText('R2 · Platform Auditor')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Back to launcher' }).getAttribute('href')).toBe('/');
    expect(screen.getByText(/authorised server-side against the capability matrix/)).toBeDefined();
  });

  it('renders the not-found screen for a declared route', async () => {
    openAs('R5', 'degraded', '/not-found');
    render(<App />);

    expect(await screen.findByText('Page not found')).toBeDefined();
    expect(screen.getByText(/The address does not match a portal screen/)).toBeDefined();
  });

  it('falls back to not-found for an unknown address', async () => {
    openAs('R5', 'degraded', '/does-not-exist/anywhere');
    render(<App />);

    expect(await screen.findByText('Page not found')).toBeDefined();
  });
});
