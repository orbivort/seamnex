import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { useEnvImport } from '@seamnex/api-client';
import type { AdmissionOutcome, CatalogEntry, EnvPlan, EnvSchemaVar } from '@seamnex/domain';
import { envProfiles, getState } from '@seamnex/mocks';
import { EnvImportControl } from '../../src/features/deploy/steps/EnvImportControl';
import { EnvironmentStep } from '../../src/features/deploy/steps/EnvironmentStep';
import { InstanceStep } from '../../src/features/deploy/steps/InstanceStep';
import { ResourcesStep } from '../../src/features/deploy/steps/ResourcesStep';
import { ReviewStep } from '../../src/features/deploy/steps/ReviewStep';
import { SourceStep } from '../../src/features/deploy/steps/SourceStep';
import type { PreflightCheck, WizardValues } from '../../src/features/deploy/steps/types';

/**
 * The steps' own contract with their caller.
 *
 * Each of these components accepts optional props — a plan that has not arrived, a capacity
 * refusal, the names the plan could not resolve, the warnings a preview returned, a route host the
 * API has not published yet. The wizard always supplies most of them, so the *absent* case is only
 * reachable by rendering the step the way another caller (or a later, narrower one) would. That is
 * what this file does: it pins the sentence each step prints when a prop is missing rather than
 * falling back to a blank space or a misleading "nothing to report".
 *
 * `useEnvImport` is stubbed for the import drawer, because the branches that matter there are a
 * mapping in flight and a payload the API answered short — neither is producible from the mock
 * platform, which always returns a complete, schema-valid import result.
 */
const importer = vi.hoisted(() => ({ stub: null as null | (() => unknown) }));

vi.mock('@seamnex/api-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // Resolved through the namespace rather than a named import: the factory must be able to fall
  // back to the real hook, and only `useEnvImport` is replaced.
  const real = actual['useEnvImport'] as typeof useEnvImport;
  return {
    ...actual,
    useEnvImport: (key: string) =>
      (importer.stub === null ? real(key) : importer.stub()) as ReturnType<typeof useEnvImport>,
  };
});

afterEach(() => {
  importer.stub = null;
});

function entryFor(key: string): CatalogEntry {
  const found = getState().catalog.find((item) => item.key === key);
  if (found === undefined) throw new Error(`the ${key} catalog fixture is missing`);
  return found;
}

function wizardValues(patch: Partial<WizardValues> = {}): WizardValues {
  return {
    slug: 'espocrm',
    profileKey: 'production',
    env: {},
    resources: { cpu: 1, memoryMb: 2048, diskMb: 20_480 },
    ...patch,
  };
}

/** A declared variable; the catalog's own defaults are the ones a step has to cope with. */
function declared(patch: Partial<EnvSchemaVar> & { name: string }): EnvSchemaVar {
  return {
    purpose: `${patch.name} is used by the instance.`,
    type: 'string',
    required: false,
    defaultValue: null,
    constraint: null,
    conditional: null,
    secret: false,
    overrideCeiling: 'profile_and_instance',
    ...patch,
  };
}

/** The plan's answer for one variable, in the shape `EnvironmentStep` reads. */
function resolution(
  variable: EnvSchemaVar,
  patch: { value?: string | null; source?: 'default' | 'profile' | 'instance' | 'secret' } & {
    masked?: boolean;
    error?: string | null;
  } = {},
): EnvPlan['values'][number] {
  return {
    ...variable,
    value: patch.value ?? null,
    source: patch.source ?? 'default',
    masked: patch.masked ?? false,
    error: patch.error ?? null,
    requiresRecreate: false,
  };
}

function planOf(values: EnvPlan['values']): EnvPlan {
  return {
    entryKey: 'D01-01',
    profileKey: 'production',
    values,
    fieldErrors: [],
    requiresRecreate: false,
    resolvedAt: '2026-10-22T09:00:00.000Z',
  };
}

function outcome(patch: Partial<AdmissionOutcome> = {}): AdmissionOutcome {
  return {
    admissible: true,
    shortfall: [],
    headline: '10.0 vCPU and 4.6 GB memory headroom after the platform reserve',
    detail: 'Admission checks the platform reserve first.',
    reserveNote: 'Reserve: 4 vCPU / 10.0 GB / 100 GB held back for the control plane.',
    limits: { cpu: 16, memoryMb: 62_259, diskMb: 943_718 },
    used: { cpu: 10.5, memoryMb: 18_432, diskMb: 122_880 },
    headroom: { cpu: 5.5, memoryMb: 43_827, diskMb: 820_838 },
    ...patch,
  };
}

describe('environment step without a resolved value', () => {
  it('says the entry declares nothing instead of rendering an empty grid', async () => {
    // An empty grid is indistinguishable from a failed read; the sentence names which of the two it
    // is, and it is the only content of a step that would otherwise be blank.
    render(
      <EnvironmentStep
        entry={entryFor('D01-01')}
        vars={[]}
        values={wizardValues()}
        errors={{}}
        onChange={() => undefined}
      />,
    );

    expect(screen.getByText(/This entry declares no environment variables/)).toBeDefined();
  });

  it('reads a variable the wizard has not seen yet as empty, not as undefined', async () => {
    // `values.env` is filled from the schema, but a caller that renders the step before the schema
    // arrives hands over a shorter map. An uncontrolled "undefined" in the input is a blank field
    // that looks like a cleared value.
    render(
      <EnvironmentStep
        entry={entryFor('D01-01')}
        vars={[declared({ name: 'UNTYPED' })]}
        values={wizardValues({ env: {} })}
        errors={{}}
        onChange={() => undefined}
      />,
    );

    expect((screen.getByLabelText(/UNTYPED/) as HTMLInputElement).value).toBe('');
  });

  it('prints an empty value as "empty" rather than as an unresolved one', async () => {
    // "not set" is a variable nothing supplied; "empty" is a variable something supplied as a blank
    // string. The operator fixes the two in different places, so the wording has to differ.
    const variable = declared({ name: 'BLANK', defaultValue: '' });

    render(
      <EnvironmentStep
        entry={entryFor('D01-01')}
        vars={[variable]}
        values={wizardValues({ env: { BLANK: '' } })}
        errors={{}}
        onChange={() => undefined}
        plan={planOf([resolution(variable, { value: '', source: 'default' })])}
      />,
    );

    expect(screen.getByText(/resolves to empty/)).toBeDefined();
  });

  it('warns that a conditional requirement has nothing resolved, without failing it', async () => {
    // The API reports a conditionally required variable as a warning here, not as an error: the
    // condition is declared per variable and only the operator can decide whether it applies.
    const variable = declared({
      name: 'SMTP_USER',
      conditional: 'required when SMTP_PASSWORD is set',
      overrideCeiling: 'profile_only',
    });

    render(
      <EnvironmentStep
        entry={entryFor('D01-01')}
        vars={[variable]}
        values={wizardValues({ env: { SMTP_USER: '' } })}
        errors={{}}
        onChange={() => undefined}
        plan={planOf([resolution(variable, { value: null })])}
      />,
    );

    expect(screen.getByText('required when SMTP_PASSWORD is set')).toBeDefined();
    expect(
      screen.getByText(/No value resolved, and the condition above makes it required/),
    ).toBeDefined();
  });

  it('prints the plan verdict in place of the static requirement note', async () => {
    // Printing "enter a value" twice, in two colours, read as two different faults. The plan's own
    // sentence wins, and the requirement note stands down.
    const required = declared({ name: 'ADMIN_EMAIL', required: true });
    const secret = declared({
      name: 'DB_PASSWORD',
      type: 'secret',
      secret: true,
      required: true,
      overrideCeiling: 'none',
    });

    render(
      <EnvironmentStep
        entry={entryFor('D01-01')}
        vars={[required, secret]}
        values={wizardValues({ env: { ADMIN_EMAIL: '', DB_PASSWORD: '' } })}
        errors={{}}
        onChange={() => undefined}
        plan={planOf([
          resolution(required, { error: 'ADMIN_EMAIL: Must be an e-mail address.' }),
          resolution(secret, { value: '••••••••', source: 'secret', masked: true }),
        ])}
      />,
    );

    expect(screen.getByText('ADMIN_EMAIL: Must be an e-mail address.')).toBeDefined();
    expect(screen.queryByText(/Required for this deployment, and nothing resolves it/)).toBeNull();
    expect(screen.getByText(/resolves to •••••••• · secret store/)).toBeDefined();
  });
});

describe('environment step controls', () => {
  it('ticks and clears a boolean the instance is allowed to override', async () => {
    // A boolean is a checkbox so both directions have to write a value: a control that only ever
    // wrote "true" could never turn a feature off.
    const flag = declared({ name: 'FLAG', type: 'boolean', defaultValue: 'false' });

    function Harness() {
      const [env, setEnv] = useState<Record<string, string>>({ FLAG: 'false' });
      return (
        <EnvironmentStep
          entry={entryFor('D01-01')}
          vars={[flag]}
          values={wizardValues({ env })}
          errors={{}}
          onChange={(patch) => setEnv(patch.env ?? {})}
        />
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByRole('checkbox'));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('checkbox'));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('renders an enum whose options the catalog did not list', async () => {
    // `options` is optional on the declared type even though the catalog refuses an optionless enum
    // when it loads the file; a step that rendered a hard-coded list would hide that refusal.
    const mode = declared({ name: 'MODE', type: 'enum' });
    const onChange = vi.fn();

    render(
      <EnvironmentStep
        entry={entryFor('D01-01')}
        vars={[mode]}
        values={wizardValues({ env: { MODE: '' } })}
        errors={{}}
        onChange={onChange}
      />,
    );

    const select = screen.getByLabelText(/MODE/) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['']);

    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ env: { MODE: '' } });
  });
});

describe('review step with nothing to report', () => {
  it('omits the unresolved, warning and route blocks the caller did not supply', async () => {
    // All three blocks are optional: a review rendered before the plan, the preview or the policy
    // read has answered must say less, not fail, and must not claim "no overrides" over a value it
    // never received.
    render(
      <ReviewStep
        entry={entryFor('D01-01')}
        values={wizardValues({ env: {} })}
        vars={[declared({ name: 'UNSET' })]}
        checks={[{ label: 'Slug is free and valid', ok: true, detail: 'espocrm is available.' }]}
      />,
    );

    expect(screen.getByText('Resolved by the API — no preview yet')).toBeDefined();
    expect(
      screen.getByText('No overrides: catalog defaults and the selected profile are used.'),
    ).toBeDefined();
    expect(screen.queryByText(/required value\(s\) are still unanswered/)).toBeNull();
    expect(screen.queryByText('Before you confirm')).toBeNull();
    expect(screen.getByText('pass')).toBeDefined();
  });
});

describe('review step with a full pre-flight', () => {
  it('gives every row its own state and offers the action of the checks that failed', async () => {
    // A pending row is not a failure and a failing row is actionable; the badge, the tone and the
    // button are the three things the operator reads off the summary before confirming.
    const onFixSlug = vi.fn();
    const checks: PreflightCheck[] = [
      {
        label: 'Admission fits the oversubscription rule',
        ok: false,
        pending: true,
        detail: 'Waiting for the capacity snapshot.',
      },
      {
        label: 'Slug is free and valid',
        ok: false,
        detail: 'crm is already in use; choose another slug.',
        action: { label: 'Edit the slug', onClick: onFixSlug },
      },
      { label: 'Catalog metadata is current', ok: true, detail: 'Verified today.' },
    ];

    render(
      <ReviewStep
        entry={entryFor('D01-01')}
        values={wizardValues({ env: { ADMIN_EMAIL: 'ops@seamnex.local', DB_PASSWORD: 'typed' } })}
        vars={[
          declared({ name: 'ADMIN_EMAIL' }),
          declared({ name: 'DB_PASSWORD', type: 'secret', secret: true }),
        ]}
        checks={checks}
        unresolved={['WP_HOME', 'NEXTCLOUD_TRUSTED_DOMAINS']}
        warnings={['The scaffold draft is approved but not yet committed.']}
        routeHost="espocrm.platform.local"
      />,
    );

    expect(screen.getByText('2 required value(s) are still unanswered')).toBeDefined();
    expect(screen.getByText('WP_HOME')).toBeDefined();
    expect(screen.getByText('Before you confirm')).toBeDefined();
    expect(screen.getByText('espocrm.platform.local')).toBeDefined();

    expect(screen.getByText('pending')).toBeDefined();
    expect(screen.getByText('fail')).toBeDefined();
    expect(screen.getByText('pass')).toBeDefined();
    expect(screen.getByText('Pre-flight will refuse this plan')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Edit the slug' }));
    expect(onFixSlug).toHaveBeenCalledTimes(1);
  });

  it('lists the overrides it will send and masks every secret among them', async () => {
    // The summary is the last chance to see what will be applied. A secret is counted like any
    // other override and never printed — the value here is already write-only in the secret store.
    render(
      <ReviewStep
        entry={entryFor('D01-01')}
        values={wizardValues({ env: { ADMIN_EMAIL: 'ops@seamnex.local', DB_PASSWORD: 'typed' } })}
        vars={[
          declared({ name: 'ADMIN_EMAIL' }),
          declared({ name: 'DB_PASSWORD', type: 'secret', secret: true }),
        ]}
        checks={[{ label: 'Slug is free and valid', ok: true, detail: 'espocrm is available.' }]}
      />,
    );

    expect(screen.getByText(/Environment overrides \(2\)/)).toBeDefined();
    expect(screen.getByText('ops@seamnex.local')).toBeDefined();
    expect(screen.getByText('••••••••')).toBeDefined();
    expect(screen.queryByText('typed')).toBeNull();
  });
});

describe('resources step verdicts', () => {
  it('explains a refused capacity read and offers no retry the caller did not supply', async () => {
    // The retry belongs to the caller that owns the query. A step that rendered one anyway would
    // offer a button that cannot refetch anything.
    const onChange = vi.fn();

    render(
      <ResourcesStep
        entry={entryFor('D01-01')}
        values={wizardValues()}
        verdict={null}
        onChange={onChange}
        capacityError="Your grant excludes capacity."
        errors={{}}
      />,
    );

    expect(screen.getByText('Checking capacity')).toBeDefined();
    expect(
      screen.getByText(/The capacity snapshot could not be read: Your grant excludes capacity\./),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry capacity' })).toBeNull();

    fireEvent.change(screen.getByLabelText(/Disk \(MB\)/), { target: { value: '40960' } });
    expect(onChange).toHaveBeenCalledWith({
      resources: { cpu: 1, memoryMb: 2048, diskMb: 40_960 },
    });
  });

  it('shows the control-plane refusal beside an admissible local verdict', async () => {
    // The two verdicts read different inputs. Printing only the browser's arithmetic promised a
    // deployment the control plane had already refused.
    render(
      <ResourcesStep
        entry={entryFor('D01-01')}
        values={wizardValues()}
        verdict={outcome()}
        onChange={() => undefined}
        serverRefusal="CPU shortfall against the admission rule. Reduce cpu and retry."
        onRetryCapacity={() => undefined}
      />,
    );

    expect(screen.getByText('Refused by the control plane')).toBeDefined();
    expect(
      screen.getByText(
        /The control plane refuses this plan: CPU shortfall against the admission rule\./,
      ),
    ).toBeDefined();
    expect(screen.queryByText('Admissible')).toBeNull();
  });

  it('names the shortfall when the browser refuses the request', async () => {
    // Advisory arithmetic still has to be legible: the shortfall is the list of axes to reduce.
    render(
      <ResourcesStep
        entry={entryFor('D01-01')}
        values={wizardValues()}
        verdict={outcome({
          admissible: false,
          shortfall: ['CPU', 'Memory'],
          headline: 'CPU, Memory shortfall against the admission rule',
        })}
        onChange={() => undefined}
        reserveText="4 vCPU, 10 GB memory and 100 GB disk are held back."
      />,
    );

    expect(screen.getByText('Insufficient capacity')).toBeDefined();
    expect(
      screen.getByText(/Shortfall: CPU, Memory\. Reduce resources or free capacity\./),
    ).toBeDefined();
    expect(screen.getByText(/4 vCPU, 10 GB memory and 100 GB disk are held back\./)).toBeDefined();
  });
});

describe('identity and source steps', () => {
  it('changes the environment profile and shows the host the API published', async () => {
    // The profile select is the only way to pick a lifecycle target; the hint next to the slug is
    // the API's answer, never a locally guessed domain.
    const onChange = vi.fn();

    render(
      <InstanceStep
        entry={entryFor('D01-01')}
        values={wizardValues()}
        errors={{}}
        profiles={envProfiles()}
        routeHost="espocrm.platform.local"
        onChange={onChange}
      />,
    );

    expect(
      screen.getByText(/Published as espocrm\.platform\.local · the edge, not this field/),
    ).toBeDefined();

    fireEvent.change(screen.getByLabelText(/Environment profile/), {
      target: { value: 'staging' },
    });
    expect(onChange).toHaveBeenCalledWith({ profileKey: 'staging' });
  });

  it('names an exception that is still awaiting a second party', async () => {
    // A requested exception is not an approval: the source path is allowed to be planned, and the
    // step has to say who has not yet signed it off.
    render(
      <SourceStep
        entry={entryFor('D04-01')}
        exception={{
          id: 'pe-105',
          rule: 'Published port',
          scope: 'D04-01 WooCommerce — inst-shop',
          justification: 'The payment sandbox calls back on a fixed host port.',
          requester: 'Priya Raman',
          approver: null,
          state: 'requested',
          requestedAt: '2026-10-20T09:00:00.000Z',
          expiresAt: '2026-11-05T09:00:00.000Z',
          patchDiff: '+ ports: ["8080:80"]',
        }}
      />,
    );

    expect(screen.getByText(/compliant/)).toBeDefined();
    expect(screen.getByText(/pe-105 · Published port · awaiting a second party/)).toBeDefined();
  });
});

describe('environment import drawer', () => {
  /** The drawer's footer and body read only these fields of the mutation result. */
  function stubbedImport(patch: Record<string, unknown>) {
    importer.stub = () => ({
      data: {
        entryKey: 'D01-01',
        source: 'dotenv',
        parsed: 0,
        fieldErrors: [],
        importedAt: '2026-10-22T09:00:00.000Z',
        ...patch,
      },
      error: null,
      isError: false,
      isPending: false,
      mutate: () => undefined,
      reset: () => undefined,
    });
  }

  it('closes through the drawer’s own control and clears the pasted content', async () => {
    // The header close button and Escape both arrive as `onOpenChange(false)`, which is a different
    // path from the Cancel button: it must reset the import result and the textarea too.
    stubbedImport({ mapped: [], unmapped: [] });
    render(<EnvImportControl entryKey="D01-01" onApply={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import .env' }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.change(within(drawer).getByLabelText('Content'), {
      target: { value: 'ADMIN_EMAIL=ops@seamnex.local' },
    });

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close panel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Import .env' }));
    const reopened = await screen.findByRole('dialog');
    expect((within(reopened).getByLabelText('Content') as HTMLTextAreaElement).value).toBe('');
  });

  it('says the mapping is in progress instead of offering to map it again', async () => {
    // A double submit would map the same document twice; the label is the only signal that the
    // request is in flight, since the button is also disabled.
    importer.stub = () => ({
      data: undefined,
      error: null,
      isError: false,
      isPending: true,
      mutate: () => undefined,
      reset: () => undefined,
    });
    render(<EnvImportControl entryKey="D01-01" onApply={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import .env' }));
    const drawer = await screen.findByRole('dialog');

    expect(within(drawer).getByRole('button', { name: 'Mapping…' })).toBeDefined();
  });

  it('falls back to its own advice when the failure is not an Error', async () => {
    // TanStack passes the rejection through untouched. A value that is not an Error has no
    // `message`, and "undefined" in a banner is worse than saying what to paste.
    importer.stub = () => ({
      data: undefined,
      error: 'env-import refused',
      isError: true,
      isPending: false,
      mutate: () => undefined,
      reset: () => undefined,
    });
    render(<EnvImportControl entryKey="D01-01" onApply={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import .env' }));
    const drawer = await screen.findByRole('dialog');

    expect(within(drawer).getByText('The environment could not be mapped')).toBeDefined();
    expect(
      within(drawer).getByText('Retry with a .env or Compose environment block.'),
    ).toBeDefined();
  });

  it('tolerates a result that omits the lists it usually carries', async () => {
    // The schema requires both lists, but the drawer reads them defensively: a response that is
    // short one of them must render an empty report, not throw.
    stubbedImport({});
    render(<EnvImportControl entryKey="D01-01" onApply={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import .env' }));
    const drawer = await screen.findByRole('dialog');

    expect(within(drawer).getByText(/0 parsed · 0 usable · 0 rejected/)).toBeDefined();
    expect(within(drawer).queryByText(/Not in the declared schema/)).toBeNull();
    expect(within(drawer).getByRole('button', { name: 'Apply 0 values' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('applies a mapped value the API left unset as an empty string', async () => {
    // `value` is nullable for a withheld secret; a value the API did not send is not a refusal to
    // map it, so it still counts as applicable rather than being dropped from the count.
    const onApply = vi.fn();
    stubbedImport({
      parsed: 1,
      mapped: [
        { name: 'ADMIN_EMAIL', value: undefined, secret: false, accepted: true, reason: null },
      ],
      unmapped: [],
    });
    render(<EnvImportControl entryKey="D01-01" onApply={onApply} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import .env' }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply 1 value' }));

    expect(onApply).toHaveBeenCalledWith({ ADMIN_EMAIL: '' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
