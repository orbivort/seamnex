import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HttpResponse, delay, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs } from '../helpers';

/**
 * The wizard's refusal paths, driven through the real app.
 *
 * Every case here is a branch the happy-path suite never reaches: a read that failed, a control
 * plane that disagreed with the browser's arithmetic, a pre-flight row that has to offer the
 * operator the one action that can fix it. They matter because a wizard that only ever renders its
 * green path leaves the operator with a disabled button and no sentence explaining it.
 */
function problem(status: number, code: string, title: string, detail: string) {
  return {
    type: `https://platform.seamnex.local/problems/${code.toLowerCase()}`,
    title,
    status,
    detail,
    code,
    fieldErrors: [],
    remediation: 'Retry once the platform is reachable.',
  };
}

/** A resolved plan the wizard cannot fault, so a case can isolate one failing input. */
function cleanPlan(entryKey: string) {
  return {
    entryKey,
    profileKey: 'production',
    values: [],
    fieldErrors: [],
    requiresRecreate: false,
    resolvedAt: '2026-10-22T09:00:00.000Z',
  };
}

/**
 * A preview the API could have produced; `warnings` and `admissible` are what a case varies.
 *
 * `blockers` is part of the contract (FR-1.11), so an admissible preview must carry an empty list —
 * a fixture without it is a response the API cannot produce, and the schema refuses it.
 */
function preview(patch: { admissible?: boolean; warnings?: string[] } = {}) {
  const admissible = patch.admissible ?? true;
  return {
    admissible,
    headline: admissible ? 'Within the host budget' : 'CPU shortfall against the admission rule',
    detail: admissible ? 'Nothing further is required.' : 'Reduce cpu and retry.',
    shortfall: { cpuMilli: admissible ? 0 : 500, memoryMb: 0, diskMb: 0 },
    capacitySource: 'measured',
    routeHost: 'espocrm.seamnex.local',
    slugAvailable: true,
    policyVerdict: 'allowed',
    policyEvaluatedAt: '2026-10-22T09:00:00.000Z',
    policySource: 'local_evaluation',
    blockers: admissible
      ? []
      : [
          {
            code: 'capacity',
            field: 'resources',
            message: 'CPU shortfall against the admission rule. Reduce cpu and retry.',
            blocking: true,
          },
        ],
    warnings: patch.warnings ?? [],
    evaluatedAt: '2026-10-22T09:00:00.000Z',
  };
}

function continueStep(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

/** The environment plan is debounced; the wizard cannot leave step 3 until it has answered. */
async function settlePlan(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 900));
}

async function toSource(): Promise<void> {
  await screen.findByText('Instance identity');
  continueStep();
  await screen.findByText('Deployment source resolution');
}

async function toEnvironment(): Promise<void> {
  await toSource();
  continueStep();
  await screen.findByLabelText(/ADMIN_EMAIL/);
}

/**
 * The only value the catalog makes unavoidable on D1.
 *
 * `DB_PASSWORD` is required too, but its ceiling is `none`, so the form disables it and the plan
 * resolves it from the secret store. Writing into a disabled field was never something an operator
 * could do; the wizard no longer asks for it.
 */
async function supplyRequiredValues(): Promise<void> {
  fireEvent.change(screen.getByLabelText(/ADMIN_EMAIL/), {
    target: { value: 'portal-admin@seamnex.local' },
  });
  await settlePlan();
}

async function toResources(): Promise<void> {
  await toEnvironment();
  await supplyRequiredValues();
  continueStep();
  await screen.findByText('Resources and admission');
}

async function toReview(): Promise<void> {
  await toResources();
  continueStep();
  await screen.findByText('Review and deploy');
}

describe('wizard entry and step navigation', () => {
  it('offers a retry when the catalog entry itself cannot be read', async () => {
    // An unreadable entry is a whole-screen return. Without the retry control the only way out is
    // a page reload, so the control is the entire recovery path.
    let attempts = 0;
    server.use(
      http.get('/api/v1/catalog/D99', () => {
        attempts += 1;
        return HttpResponse.json(
          problem(404, 'CATALOG_ENTRY_NOT_FOUND', 'Catalog entry not found', 'No entry D99.'),
          { status: 404 },
        );
      }),
    );

    openAs('R1', '/deploy/D99');
    render(<App />);

    expect(await screen.findByText('Catalog entry not found')).toBeDefined();
    const before = attempts;
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));

    await waitFor(() => expect(attempts).toBeGreaterThan(before));
  });

  it('returns to a completed step through the stepper', async () => {
    // Only a completed or current step is selectable, so the stepper is the backward navigation the
    // "Back" button replaces one press at a time — including back to the very first step.
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toEnvironment();

    fireEvent.click(screen.getByRole('button', { name: /Step 1 of 5: Identity/ }));

    expect(await screen.findByText('step 1 / 5')).toBeDefined();
  });
});

describe('pre-flight rows that refuse the plan', () => {
  it('names the summary and repeats the field errors it is blocking on', async () => {
    // The refusal is stated on the step the operator is standing on, and the jump to the summary
    // must carry the same field errors instead of an empty review screen.
    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toEnvironment();

    continueStep();

    // The environment row has genuinely failed — ADMIN_EMAIL is missing — while the slug row is only
    // *pending*, because the preview is gated on the environment being complete. The notice names the
    // failure and leaves the reading row out; naming both claimed a failure no read had found.
    expect(
      await screen.findByText(/Not yet satisfied: .*environment resolves without errors/),
    ).toBeDefined();
    expect(screen.queryByText(/Not yet satisfied: .*slug/)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Open the validation summary' }));

    expect(await screen.findByText('step 5 / 5')).toBeDefined();
    expect(screen.getAllByText(/ADMIN_EMAIL is required\./).length).toBeGreaterThan(0);
  });

  it('names a check only once it has actually failed', async () => {
    // `crm` belongs to the deployed EspoCRM, so the preview answers "taken" once the environment is
    // complete. That is a real failure, and the notice has to say so instead of only listing rows the
    // wizard has not read yet.
    openAs('R1', '/deploy/D01-01');
    render(<App />);

    await screen.findByText('Instance identity');
    fireEvent.change(screen.getByLabelText(/Route slug/), { target: { value: 'crm' } });
    continueStep();
    await screen.findByText('Deployment source resolution');
    continueStep();
    await screen.findByLabelText(/ADMIN_EMAIL/);

    await supplyRequiredValues();
    continueStep();

    expect(await screen.findByText(/Not yet satisfied: .*slug is free and valid/)).toBeDefined();
  });

  it('retries the route preview from the row that failed', async () => {
    // A preview that errored used to wait forever ("Asking the API…"); it now says so and offers
    // its own retry, which is the only control that can clear the failure.
    let calls = 0;
    server.use(
      http.post('/api/v1/instances/preview', () => {
        calls += 1;
        return HttpResponse.json(
          problem(422, 'PREVIEW_REFUSED', 'Route preview refused', 'The edge refused the preview.'),
          { status: 422 },
        );
      }),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toReview();

    expect(
      await screen.findByText(/The route preview failed: The edge refused the preview\./),
    ).toBeDefined();
    // The review must not restate a guess when the API has not named the host.
    expect(screen.getByText('Resolved by the API — no preview yet')).toBeDefined();

    const before = calls;
    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));

    await waitFor(() => expect(calls).toBeGreaterThan(before));
  });

  it('reports a slug the published list already holds when the preview is silent', async () => {
    // The `useInstances` fallback exists for exactly this window: the preview failed, and the slug
    // is nevertheless known to be taken. Saying "will be published" here would be a lie.
    server.use(
      http.post('/api/v1/instances/preview', () =>
        HttpResponse.json(
          problem(422, 'PREVIEW_REFUSED', 'Route preview refused', 'The edge refused the preview.'),
          { status: 422 },
        ),
      ),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await screen.findByText('Instance identity');
    fireEvent.change(screen.getByLabelText(/Route slug/), { target: { value: 'crm' } });
    await toSource();
    continueStep();
    await screen.findByLabelText(/ADMIN_EMAIL/);
    await supplyRequiredValues();
    continueStep();
    await screen.findByText('Resources and admission');
    continueStep();
    await screen.findByText('Review and deploy');

    expect(await screen.findByText(/crm is already in use; choose another slug\./)).toBeDefined();
  });

  it('offers the slug row the step that can change the name', async () => {
    // A taken slug is the one pre-flight failure the operator fixes in a text field, so its row has
    // to lead back to that field instead of only disabling the deploy action.
    server.use(
      http.post('/api/v1/instances/preview', () =>
        HttpResponse.json({ ...preview(), slugAvailable: false }),
      ),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toReview();

    expect(await screen.findByText('Pre-flight will refuse this plan')).toBeDefined();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the slug' }));

    expect(await screen.findByText('step 1 / 5')).toBeDefined();
  });

  it('marks the slug row pending while the preview has not answered at all', async () => {
    // A request still in flight is not a failure: painting it red made the deploy action look
    // refused for a check the platform had never run.
    server.use(
      http.post('/api/v1/instances/preview', async () => {
        await delay('infinite');
        return new HttpResponse(null, { status: 504 });
      }),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toReview();

    expect(
      await screen.findByText('Asking the API for the published host and the slug availability…'),
    ).toBeDefined();
    expect(screen.getAllByText('pending').length).toBeGreaterThan(0);
    expect(await screen.findByText('Pre-flight will refuse this plan')).toBeDefined();
  });

  it('moves to the identity step from the profile row', async () => {
    // With no profile the environment cannot resolve at all, and the fix lives two steps back; the
    // row has to carry the operator there rather than naming the problem only.
    server.use(
      http.get('/api/v1/env-profiles', () =>
        HttpResponse.json(
          problem(403, 'FORBIDDEN', 'Profiles are not readable', 'Your grant excludes profiles.'),
          { status: 403 },
        ),
      ),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toReview();

    expect(await screen.findByText(/This host has no environment profile/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Go to the identity step' }));

    expect(await screen.findByText('step 1 / 5')).toBeDefined();
  });

  it('says the same thing when the host answers with no profiles at all', async () => {
    // An empty list and a refused read are one condition for the operator: nothing to select. The
    // wording must not depend on which of the two happened.
    server.use(http.get('/api/v1/env-profiles', () => HttpResponse.json([])));

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toReview();

    expect(await screen.findByText(/This host has no environment profile/)).toBeDefined();
  });

  it('returns to the environment step from the plan row', async () => {
    // A plan the API refused is not a plan with no errors, and the only place to fix it is step 3.
    server.use(
      http.get('/api/v1/catalog/D01-01/env-plan', () =>
        HttpResponse.json(
          problem(
            422,
            'ENV_INVALID',
            'The environment did not resolve',
            'SMTP_HOST is not a hostname.',
          ),
          { status: 422 },
        ),
      ),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toReview();

    expect(
      await screen.findByText(
        /The environment could not be resolved: SMTP_HOST is not a hostname\./,
      ),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Go to the environment step' }));

    expect(await screen.findByText('step 3 / 5')).toBeDefined();
  });

  it('lists every blocker on the step that can fix it, and jumps there', async () => {
    // FR-1.11: `admissible: false` used to arrive with one headline and no field. Each blocker now
    // names its fix, so the summary is a to-do list rather than a red badge.
    server.use(
      http.post('/api/v1/instances/preview', () =>
        HttpResponse.json({
          ...preview(),
          admissible: false,
          headline: '1 blocker must be fixed first',
          detail: 'The catalogue pins "espocrm:latest", which is a floating reference.',
          blockers: [
            {
              code: 'image_unpinned',
              field: 'entryKey',
              message: 'The catalogue pins "espocrm:latest", which is a floating reference.',
              blocking: true,
            },
            {
              code: 'policy_unknown',
              field: null,
              message: 'Nothing is vendored for D01-01; the source is fetched at deployment time.',
              blocking: false,
            },
          ],
        }),
      ),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toReview();

    expect(await screen.findByText('Pre-flight blockers')).toBeDefined();
    expect(screen.getAllByText(/floating reference/).length).toBeGreaterThan(0);
    // The field the blocker belongs to, because the message alone is generic and three unanswered
    // variables all read "A value is required."
    expect(screen.getByText(/^entryKey:/)).toBeDefined();
    expect(screen.getByText(/Nothing is vendored for D01-01/)).toBeDefined();
    // The advisory entry is not a refusal, and says so.
    expect(screen.getByText('(advisory)')).toBeDefined();
    expect(screen.getByText('(blocking)')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Go to Source' }));

    expect(await screen.findByText('step 2 / 5')).toBeDefined();
    // The step that owns the blocker repeats it beside the fields it concerns.
    expect(await screen.findByText('The source pre-flight refuses this entry')).toBeDefined();
  });

  it('names the field on every blocker the disabled deploy action reports', async () => {
    // The real D07-01 plan: four unanswered variables, each arriving as the same generic sentence.
    // The reason under the action printed the first two, named nothing, and read as one blocker.
    const blocker = (field: string) => ({
      code: 'env_invalid',
      field,
      message: 'A value is required.',
      blocking: true,
    });
    server.use(
      http.post('/api/v1/instances/preview', () =>
        HttpResponse.json({
          ...preview(),
          admissible: false,
          headline: '4 blockers must be fixed first',
          detail: 'ORANGEHRM_ADMIN_PASSWORD: A value is required.',
          blockers: [
            blocker('ORANGEHRM_ADMIN_PASSWORD'),
            blocker('ORANGEHRM_DATABASE_PASSWORD'),
            blocker('ORANGEHRM_DATABASE_ROOT_PASSWORD'),
            blocker('ORANGEHRM_ADMIN_EMAIL'),
          ],
        }),
      ),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);

    const reason = await screen.findByText(/pre-flight blockers?: ORANGEHRM_ADMIN_PASSWORD/);
    expect(reason.textContent).toContain('ORANGEHRM_DATABASE_PASSWORD');
    expect(reason.textContent).toContain('ORANGEHRM_DATABASE_ROOT_PASSWORD');
    // The cap hides a long list, so it has to say how many it hid.
    expect(reason.textContent).toContain('And 1 more.');
    expect(reason.textContent).not.toContain('ORANGEHRM_ADMIN_EMAIL');
  });

  it('retries the capacity read from both the panel and the pre-flight row', async () => {
    // Admission cannot be decided without a measurement, and the failure is reported twice — once
    // where the numbers would be, once in the summary. Both retries have to be wired.
    let calls = 0;
    server.use(
      http.get('/api/v1/capacity', () => {
        calls += 1;
        return HttpResponse.json(
          problem(403, 'FORBIDDEN', 'Capacity is not readable', 'Your grant excludes capacity.'),
          { status: 403 },
        );
      }),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toResources();

    expect(
      await screen.findByText(/The capacity snapshot could not be read: Your grant excludes/),
    ).toBeDefined();
    const before = calls;
    fireEvent.click(await screen.findByRole('button', { name: 'Retry capacity' }));
    await waitFor(() => expect(calls).toBeGreaterThan(before));

    continueStep();
    await screen.findByText('Review and deploy');

    const fromSummary = calls;
    fireEvent.click(await screen.findByRole('button', { name: 'Retry capacity' }));
    await waitFor(() => expect(calls).toBeGreaterThan(fromSummary));
  });
});

describe('admission disagreements', () => {
  it('shows the shortfall when the browser refuses a plan the server still accepts', async () => {
    // `admissionVerdict` runs in the wizard as advisory arithmetic; when it refuses, the operator
    // needs the shortfall and the way back to the fields, not a silent "Checking capacity".
    const capacity = getState().capacity;
    capacity.host = { cpuCores: 2, memoryMb: 2048, diskMb: 10_240 };
    capacity.platformReserve = { cpuCores: 1, memoryMb: 512, diskMb: 1024 };
    capacity.allocated = { cpuCores: 0.5, memoryMb: 512, diskMb: 2048 };
    server.use(http.post('/api/v1/instances/preview', () => HttpResponse.json(preview())));

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toResources();

    expect(await screen.findByText('Insufficient capacity')).toBeDefined();
    const alerts = await screen.findAllByRole('alert');
    // The CPU cap is oversubscribed, so only memory and disk are short on this shape.
    expect(alerts.map((node) => node.textContent).join(' | ')).toContain(
      'Shortfall: Memory, Disk.',
    );

    continueStep();
    await screen.findByText('Review and deploy');
    fireEvent.click(await screen.findByRole('button', { name: 'Adjust the resources' }));

    expect(await screen.findByText('step 4 / 5')).toBeDefined();
  });

  it('defers to the control plane when it refuses a plan the browser admits', async () => {
    // The two verdicts read different inputs. The server's refusal is the one that would refuse the
    // POST, so a panel that showed only the local arithmetic would promise a deployment that fails.
    server.use(
      http.post('/api/v1/instances/preview', () =>
        HttpResponse.json(preview({ admissible: false })),
      ),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toResources();

    expect(await screen.findByText('Refused by the control plane')).toBeDefined();
    expect(
      screen.getByText(
        /The control plane refuses this plan: CPU shortfall against the admission rule\. Reduce cpu and retry\./,
      ),
    ).toBeDefined();
  });
});

describe('field-scoped blockers', () => {
  it('stops the step that owns a blocker instead of letting it reach review', async () => {
    // AC-07: a blocker that names a field the wizard can edit must stop that field's step. The
    // catalogue facts (an unpinned image, an unapproved scaffold) cannot be fixed here, so they stay
    // advisory for navigation and keep only the deploy action closed.
    server.use(
      http.post('/api/v1/instances/preview', () =>
        HttpResponse.json({
          ...preview(),
          admissible: false,
          headline: '6 blockers must be fixed first',
          blockers: [
            {
              code: 'env_invalid',
              field: 'profileKey',
              message: 'The profile "ghost" does not exist.',
              blocking: true,
            },
            {
              code: 'env_invalid',
              field: 'SMTP_HOST',
              message: 'SMTP_HOST is not a hostname.',
              blocking: true,
            },
            {
              code: 'secret_unresolved',
              field: 'DB_PASSWORD',
              message: 'DB_PASSWORD: the secret does not resolve.',
              blocking: true,
            },
            {
              code: 'route_conflict',
              field: 'slug',
              message: 'The slug is published by D01-01.',
              blocking: true,
            },
            {
              code: 'capacity',
              field: 'resources',
              message: 'CPU shortfall against the admission rule.',
              blocking: true,
            },
            {
              code: 'unknown_entry',
              field: 'entryKey',
              message: 'The catalogue has no such entry.',
              blocking: true,
            },
          ],
        }),
      ),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toEnvironment();
    await supplyRequiredValues();
    continueStep();

    // The environment step owns two of the six, so it refuses to advance and keeps the reason.
    expect(await screen.findByText('step 3 / 5')).toBeDefined();
    expect(await screen.findByText('SMTP_HOST is not a hostname.')).toBeDefined();
  });

  it('renders an advisory source blocker as a caution rather than a refusal', async () => {
    // The step must present whatever the contract allows: an entry-level note that names no field is
    // a caution, and only a blocking entry is drawn as a refusal.
    server.use(
      http.post('/api/v1/instances/preview', () =>
        HttpResponse.json({
          ...preview(),
          admissible: true,
          blockers: [
            {
              code: 'image_unpinned',
              field: null,
              message: 'The pin could not be checked because the registry was unreachable.',
              blocking: false,
            },
          ],
        }),
      ),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toSource();

    expect(await screen.findByText('The source pre-flight refuses this entry')).toBeDefined();
    // The preview is re-asked once the debounced inputs settle, and the step drops its blocker list
    // while the new answer is in flight: read the message by waiting for it, not once.
    await waitFor(
      () =>
        expect(
          screen.getByText('The pin could not be checked because the registry was unreachable.'),
        ).toBeDefined(),
      { timeout: 5_000 },
    );
  });
});

describe('review step content', () => {
  it('shows the warnings the preview returned before the operator confirms', async () => {
    // Warnings are not admission failures, so they never blocked the action — and were thrown away,
    // which let the operator confirm a plan whose caveats had never been shown.
    server.use(
      http.post('/api/v1/instances/preview', () =>
        HttpResponse.json(
          preview({
            warnings: [
              'The scaffold draft is approved but not yet committed to the catalog repository.',
              'This slug was deleted four days ago and stays reserved for 30 days.',
            ],
          }),
        ),
      ),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toReview();

    expect(await screen.findByText('Before you confirm')).toBeDefined();
    expect(
      screen.getByText(/The scaffold draft is approved but not yet committed to the catalog/),
    ).toBeDefined();
    expect(screen.getByText(/stays reserved for 30 days/)).toBeDefined();
  });

  it('names every unresolved variable, including the ones it only counts', async () => {
    // The plan answers for the debounced overrides, so it can still be the clean one while "Next"
    // advances. Whatever it says on arrival is what the review must report — by name, and with the
    // tail counted rather than silently dropped.
    server.use(
      http.get('/api/v1/catalog/D01-01/env-plan', ({ request }) => {
        const url = new URL(request.url);
        const overridden = [...url.searchParams.keys()].some((key) => key.startsWith('env.'));
        if (!overridden) return HttpResponse.json(cleanPlan('D01-01'));
        return HttpResponse.json({
          ...cleanPlan('D01-01'),
          fieldErrors: ['ALPHA', 'BETA', 'GAMMA', 'DELTA', 'EPSILON', 'ZETA'].map((field) => ({
            field,
            code: 'REQUIRED',
            message: `${field} is required.`,
          })),
        });
      }),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toEnvironment();

    fireEvent.change(screen.getByLabelText(/ADMIN_EMAIL/), {
      target: { value: 'portal-admin@seamnex.local' },
    });
    fireEvent.change(screen.getByLabelText(/DB_PASSWORD/), {
      target: { value: 'generated-database-secret' },
    });
    // Two presses in one tick: the debounced override has not reached the plan, so neither press is
    // held back by it. The stale answer arrives on the review step.
    continueStep();
    continueStep();

    expect(await screen.findByText('Review and deploy')).toBeDefined();
    expect(await screen.findByText('6 required value(s) are still unanswered')).toBeDefined();
    expect(screen.getByText('ALPHA')).toBeDefined();
    expect(
      await screen.findByText(/6 environment value\(s\) need attention: ALPHA, BETA, GAMMA, DELTA/),
    ).toBeDefined();
    expect(screen.getByText(/and 2 more/)).toBeDefined();
  });

  it('states that no overrides are used when the entry declares no variables', async () => {
    // "No overrides" was printed for a plan with eight unanswered values; it is only honest when the
    // entry really declares nothing to override.
    server.use(
      http.get('/api/v1/catalog/D01-01/env-schema', () => HttpResponse.json([])),
      http.get('/api/v1/catalog/D01-01/env-plan', () => HttpResponse.json(cleanPlan('D01-01'))),
    );

    openAs('R1', '/deploy/D01-01');
    render(<App />);
    await toSource();
    continueStep();

    expect(await screen.findByText(/This entry declares no environment variables/)).toBeDefined();

    continueStep();
    await screen.findByText('Resources and admission');
    continueStep();
    await screen.findByText('Review and deploy');

    expect(
      screen.getByText('No overrides: catalog defaults and the selected profile are used.'),
    ).toBeDefined();
  });
});

describe('source path exceptions', () => {
  it('names an exception that has not been approved by a second party', async () => {
    // A requested exception allows the deployment to be planned but not to start; both the source
    // step and the pre-flight summary have to say which of the two states it is in.
    const [first] = getState().policyExceptions;
    if (first === undefined) throw new Error('the policy-exception fixture is missing');
    getState().policyExceptions = [{ ...first, state: 'requested', approver: null }];
    server.use(
      http.get('/api/v1/catalog/D04-01/env-plan', () => HttpResponse.json(cleanPlan('D04-01'))),
    );

    openAs('R1', '/deploy/D04-01');
    render(<App />);
    await toSource();

    expect(
      await screen.findByText(/pe-104 · Host-path bind mount · awaiting a second party/),
    ).toBeDefined();

    continueStep();
    await screen.findByLabelText(/ADMIN_EMAIL/);
    fireEvent.change(screen.getByLabelText(/ADMIN_EMAIL/), {
      target: { value: 'shop-owner@seamnex.local' },
    });
    fireEvent.change(screen.getByLabelText(/DB_PASSWORD/), {
      target: { value: 'generated-database-secret' },
    });
    fireEvent.change(screen.getByLabelText(/WP_HOME/), {
      target: { value: 'https://shop.platform.local' },
    });
    await settlePlan();
    continueStep();
    await screen.findByText('Resources and admission');
    continueStep();
    await screen.findByText('Review and deploy');

    expect(await screen.findByText('Source path allowed by exception')).toBeDefined();
    expect(
      screen.getByText(/pe-104 · Host-path bind mount · awaiting a second party/),
    ).toBeDefined();
  });
});
