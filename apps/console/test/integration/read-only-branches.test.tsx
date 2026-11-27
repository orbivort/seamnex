import { fireEvent, render, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The read-only shapes of the two surfaces the review added.
 *
 * A role that may read the catalogue but not change it must still get a trustworthy screen: the
 * prefetch control explains who may use it rather than disappearing, and the deploy control is
 * replaced by the reason it is absent. The allow-list panel must likewise be honest when it has no
 * history to show and when the catalogue read it attributes namespaces with has failed.
 */
async function panelByTitle(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: title });
  const section = heading.closest('section');
  if (section === null) throw new Error(`no panel headed "${title}"`);
  return section;
}

describe('entry detail as a read-only role', () => {
  it('explains the prefetch restriction and offers no deploy control', async () => {
    openAs('R2', '/catalog/D01-01');
    render(<App />);

    const prefetch = await screen.findByRole('button', { name: 'Prefetch images' });
    expect(prefetch).toHaveProperty('disabled', true);
    // The tooltip says why: a disabled control with no reason reads as a defect.
    expect(prefetch.getAttribute('title')).toContain('R1 prepares images');

    expect(screen.queryByRole('link', { name: /Deploy/ })).toBeNull();
    // The control is replaced by who may use it: an absent action with no owner reads as a defect.
    expect(await screen.findByText('deploy: platform administrator')).toBeDefined();
  });
});

describe('allow-list panel without attribution', () => {
  it('says an entry is unused when the catalogue is empty, and that there is no history', async () => {
    server.use(
      http.get('/api/v1/security/trusted-registries', () =>
        HttpResponse.json({
          current: {
            ...getState().trustedRegistries.current,
            version: 1,
            entries: ['ghcr.io/seamnex'],
            note: null,
          },
          history: [],
        }),
      ),
      http.get('/api/v1/catalog', () => HttpResponse.json([])),
    );

    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await panelByTitle('Trusted registry allow-list');
    expect(await within(panel).findByText('no catalog entry uses it')).toBeDefined();
    // No revision history is stated as none, not as an empty list.
    expect(within(panel).getByText('History: 0 recorded revisions.')).toBeDefined();
    // A null note adds no sentence.
    expect(within(panel).queryByText(/Shipped default/)).toBeNull();
  });

  it('refuses to attribute products when the catalogue read failed, without hiding the list', async () => {
    server.use(
      http.get('/api/v1/catalog', () =>
        HttpResponse.json({ title: 'Unavailable', status: 503 }, { status: 503 }),
      ),
    );

    openAs('R1', '/governance/posture');
    render(<App />);

    const panel = await panelByTitle('Trusted registry allow-list');
    expect(await within(panel).findByText('Products cannot be attributed')).toBeDefined();
    // The allow-list itself is still listed: the failure is the attribution, not the control.
    expect(await within(panel).findByText('docker.io/mautic')).toBeDefined();
  });
});

describe('findings drawer', () => {
  it('closes on Escape and leaves the image list where it was', async () => {
    openAs('R1', '/instances/inst-collab');
    render(<App />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Image security' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Findings' }));
    expect(await screen.findByText('CVE-2026-31884')).toBeDefined();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    // The drawer unmounts with its query; the panel behind it is untouched.
    expect(getState().instanceDetails['inst-collab']).toBeDefined();
  });
});
