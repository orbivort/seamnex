import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The deploy wizard is one operator action with a pre-flight in front of it. It must refuse an
 * invalid slug, refuse to continue while a required environment value is missing, refuse a
 * resource shape below the catalog minimum, and only then submit.
 */
async function continueStep(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

/**
 * The one value the operator has to supply on EspoCRM.
 *
 * `DB_PASSWORD` is also required, but its ceiling is `none`: the form disables it and the plan
 * resolves it from the secret store, so the wizard must not demand it — a local rule that did made
 * step 3 a dead end for every real operator. That contract is asserted in its own test below.
 */
async function supplyRequiredValues(): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/ADMIN_EMAIL/), {
    target: { value: 'portal-admin@seamnex.local' },
  });
  // The environment plan is debounced; let it settle before asking to continue.
  await new Promise((resolve) => setTimeout(resolve, 900));
}

async function reachEnvironment(): Promise<void> {
  await screen.findByText('Instance identity');
  await continueStep();
  await screen.findByText('Deployment source resolution');
  await continueStep();
  await screen.findByText(/Environment for EspoCRM/);
}

async function reachResources(): Promise<void> {
  await reachEnvironment();
  await supplyRequiredValues();
  await continueStep();
  await screen.findByText('Resources and admission');
}

describe('deploy wizard', () => {
  it('opens on the identity step with the deployment shape', async () => {
    openAs('R1', '/deploy/D01-01');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Deploy EspoCRM' })).toBeDefined();
    expect(await screen.findByText('Instance identity')).toBeDefined();
    expect(screen.getByText('Deployment shape')).toBeDefined();
    expect(screen.getByText('step 1 / 5')).toBeDefined();
    expect(await screen.findByLabelText(/Route slug/)).toBeDefined();
  });

  it('refuses a slug that is not a DNS label', async () => {
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await screen.findByText('Instance identity');

    fireEvent.change(screen.getByLabelText(/Route slug/), { target: { value: 'A B' } });
    await continueStep();

    expect(
      await screen.findByText('Use lower-case letters, digits and dashes (2–48 characters).'),
    ).toBeDefined();
    expect(screen.getByText('step 1 / 5')).toBeDefined();
  });

  it('walks the five steps and deploys once the required values are supplied', async () => {
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await reachEnvironment();

    await supplyRequiredValues();
    await continueStep();
    expect(await screen.findByText('Resources and admission')).toBeDefined();
    expect(
      await screen.findByText(/Admissible|Insufficient capacity|Checking capacity/),
    ).toBeDefined();

    await continueStep();
    expect(await screen.findByText('Review and deploy')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Deploy instance' }));

    // The wizard is replaced by the progress panel of the accepted job.
    expect(await screen.findByText(/Deploy D01-01 EspoCRM/)).toBeDefined();
    expect(
      screen.getByText(/The instance is not reported ready until every container runs/),
    ).toBeDefined();
  });

  it('refuses to continue while a required environment value is missing', async () => {
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await reachEnvironment();

    await continueStep();

    expect(await screen.findByText('ADMIN_EMAIL is required.')).toBeDefined();
    expect(screen.getByText('step 3 / 5')).toBeDefined();
  });

  it('locks a required secret the plan resolves instead of demanding it', async () => {
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await reachEnvironment();

    // The form cannot accept a value here, and the plan answers one from the secret store, so the
    // wizard has nothing to ask for. It used to require one anyway and stopped on step 3 for ever.
    expect((screen.getByLabelText(/DB_PASSWORD/) as HTMLInputElement).disabled).toBe(true);

    await supplyRequiredValues();
    await continueStep();

    expect(await screen.findByText('Resources and admission')).toBeDefined();
    expect(screen.queryByText('DB_PASSWORD is required.')).toBeNull();
  });

  it('refuses resources below the catalog minimum', async () => {
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await reachResources();

    fireEvent.change(screen.getByLabelText(/Memory \(MB\)/), { target: { value: '128' } });
    await continueStep();

    expect(
      await screen.findByText(/Memory must be at least 256 MB|Below the catalog minimum/),
    ).toBeDefined();
  });

  it('refuses a CPU of zero', async () => {
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await reachResources();

    fireEvent.change(screen.getByLabelText(/CPU \(vCPU\)/), { target: { value: '0' } });
    await continueStep();

    expect(await screen.findByText('CPU must be greater than zero.')).toBeDefined();
  });

  it('warns that a published slug is taken before submitting', async () => {
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await screen.findByText('Instance identity');

    fireEvent.change(screen.getByLabelText(/Route slug/), { target: { value: 'crm' } });

    // The pre-flight names the check it failed rather than only disabling the action.
    expect(await screen.findByText(/Not yet satisfied: .*slug is free and valid/)).toBeDefined();
  });

  it('goes back to the previous step and stops at the first', async () => {
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await screen.findByText('Instance identity');

    expect(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')).toBe(true);
    await continueStep();
    await screen.findByText('Deployment source resolution');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Instance identity')).toBeDefined();
  });

  it('explains an unknown entry rather than rendering an empty wizard', async () => {
    openAs('R1', '/deploy/D99');
    render(<App />);

    expect(await screen.findByText(/No entry key|could not be reached|not found/i)).toBeDefined();
  });

  it('keeps an auditor out of the wizard', async () => {
    openAs('R2', '/deploy/D01-01');
    render(<App />);

    expect(await screen.findByText(/not permitted for your role/i)).toBeDefined();
  });

  it('reports a refused submission without losing the wizard', async () => {
    server.use(
      http.post('/api/v1/instances', () =>
        HttpResponse.json(
          {
            type: 'https://platform.seamnex.local/problems/capacity',
            title: 'Insufficient capacity',
            status: 422,
            detail: 'The host has no room for this plan.',
            code: 'CAPACITY_INSUFFICIENT',
            fieldErrors: [],
            remediation: 'Reduce the request or free capacity.',
          },
          { status: 422 },
        ),
      ),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await reachResources();
    await continueStep();
    await screen.findByText('Review and deploy');

    fireEvent.click(screen.getByRole('button', { name: 'Deploy instance' }));

    expect(await screen.findByText('Insufficient capacity')).toBeDefined();
    expect(screen.getByText('Review and deploy')).toBeDefined();
  });

  it('names the approved exception that allows an otherwise refused source path', async () => {
    openAs('R1', '/deploy/D04-01');
    render(<App />);
    await screen.findByRole('heading', { name: 'Deploy WooCommerce' });

    await continueStep();
    expect(await screen.findByText('Deployment source resolution')).toBeDefined();
    expect(await screen.findByText(/exception-approved · pe-104/)).toBeDefined();
  });

  it('uses the platform scaffold path where no upstream source exists', async () => {
    openAs('R1', '/deploy/D02-01');
    render(<App />);
    await screen.findByRole('heading', { name: 'Deploy Mautic' });

    await continueStep();
    expect(await screen.findByText('Deployment source resolution')).toBeDefined();
    expect(await screen.findByText('Scaffolded entries require an approved draft')).toBeDefined();
  });

  it('does not create an instance when the wizard is abandoned', async () => {
    const before = getState().instances.length;
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await screen.findByText('Instance identity');

    await waitFor(() => expect(getState().instances).toHaveLength(before));
    expect(screen.queryByText('Review and deploy')).toBeNull();
  });
});
