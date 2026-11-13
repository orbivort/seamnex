import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

describe('failure visibility', () => {
  it('renders a problem panel when the transport fails (no silent blank state)', async () => {
    server.use(http.get('/api/v1/instances', () => HttpResponse.error()));

    openAs('R1', '/instances');
    render(<App />);

    expect(await screen.findByText(/could not be reached|did not answer/i)).toBeDefined();
    expect(await screen.findByRole('button', { name: /Retry/i })).toBeDefined();
  });

  it('renders the problem document when the API answers 503', async () => {
    server.use(
      http.get('/api/v1/instances', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/unavailable',
            title: 'Control plane is restarting',
            status: 503,
            detail: 'The API is temporarily unavailable.',
            code: 'UNAVAILABLE',
            fieldErrors: [],
            remediation: 'Retry in a minute.',
          },
          { status: 503, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    openAs('R1', '/instances');
    render(<App />);

    expect(await screen.findByText('Control plane is restarting')).toBeDefined();
    expect(await screen.findByText('Retry in a minute.')).toBeDefined();
  });

  it('does not claim "nothing needs attention" when the posture query fails', async () => {
    server.use(http.get('/api/v1/posture', () => HttpResponse.error()));

    openAs('R1');
    render(<App />);

    expect(await screen.findByText(/could not be reached|did not answer/i)).toBeDefined();
    expect(screen.queryByText(/Nothing needs attention/i)).toBeNull();
    expect(screen.queryByText(/All readiness, restore and metadata checks pass/i)).toBeNull();
  });

  it('renders a route-level boundary instead of blanking the shell', async () => {
    openAs('R1', '/instances/does-not-exist');
    render(<App />);

    // The detail screen surfaces a 404 problem and the navigation stays mounted.
    expect(await screen.findByText(/Instance not found/i)).toBeDefined();
    expect(screen.getByRole('navigation')).toBeDefined();
  });
});
