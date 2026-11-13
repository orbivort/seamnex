import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The wizard's steps own their own edge cases: an imported .env is mapped, not trusted; a boolean
 * variable is a checkbox and an enum is a select; admission cannot be decided without a measurement.
 */
async function reachEnvironment(): Promise<void> {
  await screen.findByText('Instance identity');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText('Deployment source resolution');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText(/Environment for/);
}

describe('environment import', () => {
  it('maps pasted values into the declared schema and applies them', async () => {
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await reachEnvironment();

    fireEvent.click(screen.getByRole('button', { name: 'Import .env' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Import an existing environment')).toBeDefined();

    const map = within(drawer).getByRole('button', { name: 'Map values' });
    expect(map.hasAttribute('disabled')).toBe(true);

    fireEvent.change(within(drawer).getByLabelText('Content'), {
      target: {
        value: 'ADMIN_EMAIL=imported-admin@seamnex.local\nTZ=UTC\nNOT_A_DECLARED_KEY=1',
      },
    });
    fireEvent.change(within(drawer).getByLabelText('Source format'), {
      target: { value: 'compose' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Map values' }));

    expect(await within(drawer).findByText(/parsed · .* usable · .* rejected/)).toBeDefined();
    expect(await within(drawer).findByText('imported-admin@seamnex.local')).toBeDefined();
    expect(
      within(drawer).getByText(/Not in the declared schema: NOT_A_DECLARED_KEY/),
    ).toBeDefined();

    fireEvent.click(within(drawer).getByRole('button', { name: /Apply \d+ value/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await screen.findByLabelText(/ADMIN_EMAIL/)) as HTMLInputElement).toHaveProperty(
      'value',
      'imported-admin@seamnex.local',
    );
  });

  it('withholds a secret rather than importing it', async () => {
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await reachEnvironment();

    fireEvent.click(screen.getByRole('button', { name: 'Import .env' }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.change(within(drawer).getByLabelText('Content'), {
      target: { value: 'DB_PASSWORD=leaked-in-a-file\nADMIN_EMAIL=ops@seamnex.local' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Map values' }));

    expect(await within(drawer).findByText('withheld')).toBeDefined();
  });

  it('reports a document that cannot be mapped', async () => {
    server.use(
      http.post('/api/v1/catalog/:key/env-import', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/unprocessable',
            title: 'The environment could not be read',
            status: 422,
            detail: 'Line 2 is not a KEY=value pair.',
            code: 'ENV_IMPORT_INVALID',
            fieldErrors: [],
            remediation: 'Paste a .env file or a Compose environment block.',
          },
          { status: 422 },
        ),
      ),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await reachEnvironment();

    fireEvent.click(screen.getByRole('button', { name: 'Import .env' }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.change(within(drawer).getByLabelText('Content'), {
      target: { value: 'this is not an env file' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Map values' }));

    expect(await within(drawer).findByText('The environment could not be mapped')).toBeDefined();
  });

  it('cancels without applying anything', async () => {
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await reachEnvironment();

    fireEvent.click(screen.getByRole('button', { name: 'Import .env' }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((screen.getByLabelText(/ADMIN_EMAIL/) as HTMLInputElement).value).toBe('');
  });
});

describe('environment step controls', () => {
  it('renders a boolean variable as a checkbox', async () => {
    openAs('R1', '/deploy/D07-01');
    render(<App />);
    await reachEnvironment();

    expect(await screen.findByRole('checkbox', { name: /LDAP/i })).toBeDefined();
  });

  it('renders an enum variable as a select with the declared options', async () => {
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await reachEnvironment();

    const tz = screen.getByLabelText(/TZ/) as HTMLSelectElement;
    expect([...tz.options].map((option) => option.value)).toContain('UTC');
  });

  it('shows a locked variable as read-only', async () => {
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await reachEnvironment();

    const secret = screen.getByLabelText(/DB_PASSWORD/) as HTMLInputElement;
    expect(secret.disabled).toBe(true);
    expect(secret.type).toBe('password');
  });
});

describe('admission', () => {
  it('refuses to decide admission without a capacity measurement', async () => {
    server.use(http.get('/api/v1/capacity', () => HttpResponse.error()));

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await reachEnvironment();

    fireEvent.change(await screen.findByLabelText(/ADMIN_EMAIL/), {
      target: { value: 'portal-admin@seamnex.local' },
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Resources and admission')).toBeDefined();
    expect(await screen.findByText(/The capacity snapshot could not be read/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry capacity' })).toBeDefined();
  });
});
