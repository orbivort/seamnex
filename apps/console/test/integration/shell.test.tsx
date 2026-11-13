import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app';
import { openAs, present } from '../helpers';

/**
 * The shell: role-filtered navigation, the command palette, the prototype chrome and the route
 * boundaries. A palette that keeps its previous query, or a 404 that blanks the shell, is the kind
 * of defect these tests exist to catch.
 */
async function openPalette() {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  return screen.findByRole('dialog');
}

describe('console shell', () => {
  it('renders the navigation for the role and marks the current section', async () => {
    openAs('R1', '/catalog');
    render(<App />);
    await screen.findByText('Domain catalog');

    const nav = present(screen.getAllByRole('navigation')[0], 'the navigation landmark');
    const catalogLink = within(nav).getByRole('link', { name: /Catalog/ });
    expect(catalogLink.getAttribute('aria-current')).toBe('page');
  });

  it('names the area the current screen belongs to', async () => {
    openAs('R1', '/governance/audit');
    render(<App />);
    await screen.findByRole('heading', { name: 'Audit trail' });

    expect(screen.getAllByText('Governance').length).toBeGreaterThan(0);
  });

  it('hides the administration group from a role that cannot administer', async () => {
    openAs('R4', '/instances');
    render(<App />);
    await screen.findByRole('heading', { name: 'Instances' });

    const nav = present(screen.getAllByRole('navigation')[0], 'the navigation landmark');
    expect(within(nav).queryByRole('link', { name: /Groups & mappings/ })).toBeNull();
  });

  it('advertises the simulated provenance of the data', async () => {
    openAs('R1');
    render(<App />);
    await screen.findByText('Portfolio overview');

    expect(screen.getByText('Prototype')).toBeDefined();
    expect(screen.getByText('simulated data')).toBeDefined();
    // The build's own identity, injected from the root `package.json` (`__SEAMNEX_VERSION__`). The
    // shape is asserted rather than the number, so a version bump does not fail the suite.
    expect(screen.getByText(/^v\d+\.\d+\.\d+/)).toBeDefined();
    expect(screen.queryByText('Prototype role: Platform administrator')).toBeNull();
    expect(screen.getByLabelText(/Prototype role/)).toBeDefined();
  });

  it('opens the command palette from the keyboard and closes it again', async () => {
    openAs('R1');
    render(<App />);
    await screen.findByText('Portfolio overview');

    const dialog = await openPalette();
    expect(within(dialog).getByText('Jump to')).toBeDefined();

    fireEvent.keyDown(within(dialog).getByRole('combobox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('filters the palette and opens the chosen section', async () => {
    openAs('R1');
    render(<App />);
    await screen.findByText('Portfolio overview');

    const dialog = await openPalette();
    const input = within(dialog).getByRole('combobox');
    fireEvent.change(input, { target: { value: 'break' } });

    expect(await within(dialog).findByText('Break-glass')).toBeDefined();
    expect(within(dialog).queryByText('Overview')).toBeNull();

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByRole('heading', { name: 'Break-glass sessions' })).toBeDefined();
  });

  it('moves the palette cursor with the pointer and keeps one row selected', async () => {
    openAs('R1');
    render(<App />);
    await screen.findByText('Portfolio overview');

    const dialog = await openPalette();
    const options = within(dialog).getAllByRole('option');
    fireEvent.mouseOver(present(options[2], 'the third palette row'));

    expect(within(dialog).getAllByRole('option')[2]?.getAttribute('aria-selected')).toBe('true');
  });

  it('does not header a section it cannot name for an unmapped route', async () => {
    openAs('R1', '/forbidden');
    render(<App />);

    expect(
      await screen.findByText(/The console is for platform and domain operators/),
    ).toBeDefined();
    // No sidebar entry matches, so the masthead falls back to the console name.
    expect(screen.getAllByText('Console').length).toBeGreaterThan(0);
  });

  it('moves the palette cursor with the arrow keys and warms the target', async () => {
    openAs('R1');
    render(<App />);
    await screen.findByText('Portfolio overview');

    const dialog = await openPalette();
    const input = within(dialog).getByRole('combobox');
    const options = within(dialog).getAllByRole('option');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(within(dialog).getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(within(dialog).getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true');
    expect(options.length).toBeGreaterThan(1);
  });

  it('says when no section matches and announces the settled count', async () => {
    openAs('R1');
    render(<App />);
    await screen.findByText('Portfolio overview');

    const dialog = await openPalette();
    const input = within(dialog).getByRole('combobox');
    fireEvent.change(input, { target: { value: 'nothing-here' } });

    expect(await within(dialog).findByText(/No section matches/)).toBeDefined();
    // The live region waits for typing to settle before it announces the result.
    await waitFor(() =>
      expect(within(dialog).getByRole('status').textContent).toContain('No section matches'),
    );
  });

  it('offers every permitted section in the palette', async () => {
    openAs('R1');
    render(<App />);
    await screen.findByText('Portfolio overview');

    const dialog = await openPalette();
    const options = within(dialog).getAllByRole('option');
    expect(options.length).toBeGreaterThanOrEqual(20);
  });

  it('renders a route-level not-found without blanking the shell', async () => {
    openAs('R1', '/does-not-exist');
    render(<App />);

    expect(await screen.findByText('Console page not found')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Go back' })).toBeDefined();
    // The sidebar is still there.
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0);
  });

  it('sends a portal-only role to the forbidden panel', async () => {
    openAs('R5', '/');
    render(<App />);

    expect(
      await screen.findByText(/The console is for platform and domain operators/),
    ).toBeDefined();
    expect(screen.getByRole('link', { name: /Open the portal/ })).toBeDefined();
  });

  it('renders the sign-in page for an unauthenticated visitor', async () => {
    openAs('R1', '/sign-in');
    render(<App />);

    expect(await screen.findByText(/Operations console/)).toBeDefined();
  });

  it('refuses a route whose capability the role does not hold', async () => {
    // A product administrator holds neither break-glass capability.
    openAs('R4', '/governance/break-glass');
    render(<App />);

    expect(await screen.findByText(/not permitted for your role/i)).toBeDefined();
  });

  it('admits a route whose guard is satisfied by any of its capabilities', async () => {
    openAs('R3', '/governance/break-glass');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Break-glass sessions' })).toBeDefined();
  });

  it('requires an outright grant for the administration surfaces', async () => {
    openAs('R2', '/admin/groups');
    render(<App />);

    expect(await screen.findByText(/not permitted for your role/i)).toBeDefined();
  });

  it('presents the prototype controls with the session they describe', async () => {
    openAs('R3', '/');
    render(<App />);
    await screen.findByText('Portfolio overview');

    const role = screen.getByLabelText(/Prototype role/) as HTMLSelectElement;
    expect(role.value).toBe('R3');
    expect([...role.options]).toHaveLength(6);

    const scenario = screen.getByLabelText(/Prototype scenario/) as HTMLSelectElement;
    expect(scenario.value).toBe('degraded');
    expect([...scenario.options].length).toBeGreaterThan(1);

    const latency = screen.getByLabelText(/Simulated network latency/) as HTMLSelectElement;
    expect(latency.value).toBe('0');
    expect([...latency.options]).toHaveLength(5);

    // The footer explains what the three controls do.
    expect(
      screen.getByText(/Role switching re-renders navigation and capability gates/),
    ).toBeDefined();
  });
});
