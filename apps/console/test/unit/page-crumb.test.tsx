import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { CrumbProvider, usePageCrumb } from '../../src/page-crumb';

/**
 * The screen name the topbar shows under the area.
 *
 * Callers announce through a context provider, but the hook's default is a no-op rather than a
 * throw: a screen mounted outside the console chrome (a test, a future standalone route) must still
 * render. The crumb is keyed by pathname so a child effect cannot wipe it on navigation.
 */
function CrumbProbe({ label }: { label: string | null | undefined }) {
  usePageCrumb(label);
  return null;
}

describe('usePageCrumb', () => {
  it('renders outside a provider without announcing anywhere', () => {
    expect(() =>
      render(
        <MemoryRouter initialEntries={['/instances/inst-projects']}>
          <CrumbProbe label="OpenProject" />
        </MemoryRouter>,
      ),
    ).not.toThrow();
  });

  it('announces the label with the path it was read on', () => {
    const announce = vi.fn();
    render(
      <MemoryRouter initialEntries={['/instances/inst-projects']}>
        <CrumbProvider value={announce}>
          <CrumbProbe label="OpenProject" />
        </CrumbProvider>
      </MemoryRouter>,
    );

    expect(announce).toHaveBeenCalledWith({
      path: '/instances/inst-projects',
      label: 'OpenProject',
    });
  });

  it('stays silent for a screen that has no label yet', () => {
    const announce = vi.fn();
    render(
      <MemoryRouter initialEntries={['/instances/inst-projects']}>
        <CrumbProvider value={announce}>
          <CrumbProbe label={null} />
        </CrumbProvider>
      </MemoryRouter>,
    );

    expect(announce).not.toHaveBeenCalled();
  });

  it('does not announce an empty label', () => {
    const announce = vi.fn();
    render(
      <MemoryRouter initialEntries={['/']}>
        <CrumbProvider value={announce}>
          <CrumbProbe label="" />
        </CrumbProvider>
      </MemoryRouter>,
    );

    expect(announce).not.toHaveBeenCalled();
  });
});
