import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntry } from '@seamnex/domain';
import { VerificationForm } from '../../src/features/catalog/VerificationForm';

/**
 * FR-2.14 / FR-2.15 / AC-41 — the verification form, driven directly.
 *
 * The page test proves the form is on screen; these cases pin the rules that make it evidence: only
 * changed facts travel, an unparseable inventory blocks the write instead of being sent as `[]`, and
 * a granularity that cannot scope credentials says so before the operator records it.
 */
const verify = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: null as unknown,
}));

function entry(overrides: Partial<CatalogEntry['integration']> = {}): CatalogEntry {
  return {
    key: 'D01-01',
    integration: {
      apiBaseUrl: 'https://crm.example.test/api',
      authMethod: 'oidc',
      guaranteeClassVerified: 'native',
      operationInventory: [
        { id: 'contacts.list', label: 'List contacts', mode: 'read', description: '' },
      ],
      eventModes: [{ mode: 'webhook', label: 'Webhooks' }],
      credentialGranularity: 'scoped',
      sessionMaxMinutes: 60,
      sloSupported: true,
      verifiedBy: 'alice',
      verifiedAt: '2026-01-01T00:00:00.000Z',
      nextReviewAt: '2026-04-01T00:00:00.000Z',
      stale: false,
      ...overrides,
    },
  } as unknown as CatalogEntry;
}

function mutation(): Parameters<typeof VerificationForm>[0]['verify'] {
  return verify as unknown as Parameters<typeof VerificationForm>[0]['verify'];
}

beforeEach(() => {
  verify.mutate.mockReset();
  verify.isPending = false;
  verify.isError = false;
  verify.error = null;
});

describe('verification form', () => {
  it('refuses to record a review that changes nothing', () => {
    render(<VerificationForm entry={entry()} verify={mutation()} canVerify />);

    // Recording the values it just read would restart the review clock on no evidence.
    expect(screen.getByText(/Change at least one fact/)).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Record verified review' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('sends only the facts the operator changed', () => {
    render(<VerificationForm entry={entry()} verify={mutation()} canVerify />);

    fireEvent.change(screen.getByLabelText('Authentication method'), {
      target: { value: 'saml' },
    });
    fireEvent.change(screen.getByLabelText('API base URL'), {
      target: { value: 'http://crm:8080/api' },
    });
    fireEvent.change(screen.getByLabelText('Guarantee class'), {
      target: { value: 'fa_delegated' },
    });
    fireEvent.change(screen.getByLabelText('Session maximum (minutes)'), {
      target: { value: '45' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Single logout supported/ }));

    expect(screen.getByText(/Recording: Authentication method, API base URL/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Record verified review' }));

    expect(verify.mutate).toHaveBeenCalledWith({
      authMethod: 'saml',
      apiBaseUrl: 'http://crm:8080/api',
      guaranteeClass: 'fa_delegated',
      sessionMaxMinutes: 45,
      sloSupported: false,
    });
  });

  it('records a parsed operation inventory and event modes', () => {
    render(<VerificationForm entry={entry()} verify={mutation()} canVerify />);

    fireEvent.change(screen.getByLabelText('Operation inventory (JSON)'), {
      target: {
        value: JSON.stringify([
          { id: 'contacts.list', label: 'List contacts', mode: 'read', description: '' },
          { id: 'contacts.create', label: 'Create contact', mode: 'write', description: '' },
        ]),
      },
    });
    fireEvent.change(screen.getByLabelText('Event modes (JSON)'), {
      target: { value: '[]' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record verified review' }));

    expect(verify.mutate).toHaveBeenCalledWith({
      operationInventory: [
        { id: 'contacts.list', label: 'List contacts', mode: 'read', description: '' },
        { id: 'contacts.create', label: 'Create contact', mode: 'write', description: '' },
      ],
      eventModes: [],
    });
  });

  it('blocks the write on an inventory that is not JSON, naming the field', () => {
    render(<VerificationForm entry={entry()} verify={mutation()} canVerify />);

    fireEvent.change(screen.getByLabelText('Operation inventory (JSON)'), {
      target: { value: '[{' },
    });

    expect(screen.getByText('Operation inventory: not valid JSON')).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Record verified review' }).hasAttribute('disabled'),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText('Operation inventory (JSON)'), {
      target: { value: '{"id":"x"}' },
    });
    expect(screen.getByText('Operation inventory: must be a JSON array')).toBeDefined();
  });

  it('reports a broken event list only once the inventory parses', () => {
    render(<VerificationForm entry={entry()} verify={mutation()} canVerify />);

    fireEvent.change(screen.getByLabelText('Event modes (JSON)'), { target: { value: 'nope' } });

    expect(screen.getByText('Event modes: not valid JSON')).toBeDefined();
  });

  it('refuses a session maximum that is not a positive whole number', () => {
    render(<VerificationForm entry={entry()} verify={mutation()} canVerify />);

    fireEvent.change(screen.getByLabelText('Session maximum (minutes)'), {
      target: { value: '0' },
    });
    expect(screen.getByText('Enter a positive whole number of minutes.')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Session maximum (minutes)'), {
      target: { value: '90' },
    });
    expect(screen.queryByText('Enter a positive whole number of minutes.')).toBeNull();
  });

  it('warns that a product without scoped credentials cannot be written to', () => {
    render(<VerificationForm entry={entry()} verify={mutation()} canVerify />);

    fireEvent.change(screen.getByLabelText('Credential granularity'), {
      target: { value: 'none' },
    });

    expect(screen.getByText('write-ineligible')).toBeDefined();
    expect(screen.getByText('workflow-ineligible')).toBeDefined();
    expect(screen.getByText('What this granularity costs')).toBeDefined();
  });

  it('keeps every input closed and the action disabled without the right', () => {
    render(<VerificationForm entry={entry()} verify={mutation()} canVerify={false} />);

    expect((screen.getByLabelText('Authentication method') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(
      screen.getByRole('button', { name: 'Record verified review' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('reports progress while the verification is in flight', () => {
    verify.isPending = true;

    render(<VerificationForm entry={entry()} verify={mutation()} canVerify />);

    expect(screen.getByRole('button', { name: 'Recording…' }).hasAttribute('disabled')).toBe(true);
  });
});
