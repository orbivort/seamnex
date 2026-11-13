import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState, resetState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The screenshot-level defect this suite pins: the page carried one badge called "coverage" that
 * held the *restore* ratio while the description promised SSO coverage. A fleet with every
 * deployment behind the IdP rendered "0% coverage", contradicting "6 of 6" in the same panel.
 */
const NOW = '2026-11-02T15:00:00.000Z';

function posture(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: NOW,
    sso: { native: 2, forwardAuth: 4, signInRequired: 0, totalEntries: 6 },
    missingHealthChecks: [],
    unverifiedRestores: Array.from({ length: 6 }, (_, index) => ({
      instanceId: `inst-${index}`,
      product: `Product ${index}`,
      lastVerifiedAt: null,
    })),
    expiringCertificates: [],
    staleMetadata: [],
    instancesWithoutHealthCheck: 0,
    totalInstances: 6,
    coveragePercent: 0,
    ...overrides,
  };
}

describe('security posture (FR-4.8)', () => {
  it('reports SSO coverage and restore coverage as separate facts', async () => {
    server.use(http.get('/api/v1/posture', () => HttpResponse.json(posture())));

    openAs('R1', '/governance/posture');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Security posture' })).toBeDefined();
    expect(await screen.findByText('SSO 6/6')).toBeDefined();
    expect(screen.getByText('Restores 0/6')).toBeDefined();
    // The restore ratio may not be presented as generic "coverage" next to an SSO promise.
    expect(screen.queryByText('0% coverage')).toBeNull();
    expect(screen.getByText(/Native floor \(S-2\): 2 of 6 required/)).toBeDefined();
  });

  it('does not describe an empty certificate list as proof of health', async () => {
    server.use(http.get('/api/v1/posture', () => HttpResponse.json(posture())));

    openAs('R1', '/governance/posture');
    render(<App />);

    expect(await screen.findByText(/No certificate was reported/)).toBeDefined();
    expect(screen.queryByText(/healthy state/i)).toBeNull();
  });

  it('names instances with no health observation and links to them', async () => {
    server.use(
      http.get('/api/v1/posture', () =>
        HttpResponse.json(
          posture({
            missingHealthChecks: [{ instanceId: 'inst-metabase', product: 'Metabase' }],
            instancesWithoutHealthCheck: 1,
            // Keep the SSO counts consistent with a real fleet: the gate class is separate.
            sso: { native: 2, forwardAuth: 3, signInRequired: 1, totalEntries: 6 },
          }),
        ),
      ),
    );

    openAs('R1', '/governance/posture');
    render(<App />);

    expect(await screen.findByText('No health check observed')).toBeDefined();
    const link = screen.getByRole('link', { name: 'Inspect Metabase' });
    expect(link.getAttribute('href')).toBe('/instances/inst-metabase');
  });

  /*
   * ADR-BE-22: a gated deployment whose credential the platform holds is still `fa_gate`, but the
   * board may not keep describing the whole class as "provisioned outside the platform" — that was
   * the sentence an auditor read for OpenProject while the relay was signing people in.
   */
  it('reports the gated deployments whose credential the platform manages', async () => {
    server.use(
      http.get('/api/v1/posture', () =>
        HttpResponse.json(
          posture({
            sso: {
              native: 2,
              forwardAuth: 3,
              signInRequired: 1,
              totalEntries: 6,
              platformManagedCredentials: 1,
            },
          }),
        ),
      ),
    );

    openAs('R1', '/governance/posture');
    render(<App />);

    expect(await screen.findByText('Platform-managed credentials')).toBeDefined();
    expect(screen.getByText('1 of 1 gated deployments')).toBeDefined();
    expect(await screen.findByText(/sign you in with a platform-managed credential/)).toBeDefined();
    // The relay is a password mechanism, so the board may not start calling it single sign-on.
    expect(screen.queryByText(/its credential is provisioned outside the platform/)).toBeNull();
  });

  it('counts the native floor per deployment, never per catalog entry', () => {
    resetState('degraded');
    const { posture: mockPosture } = getState();

    // 13 catalog entries, 12 deployments: D5 and D6 share the ERPNext deployment.
    expect(mockPosture.totalInstances).toBe(12);
    expect(mockPosture.sso.totalEntries).toBe(13);
    expect(
      mockPosture.sso.native + mockPosture.sso.forwardAuth + mockPosture.sso.signInRequired,
    ).toBe(mockPosture.totalInstances);
  });
});
