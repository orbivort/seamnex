import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvProfile } from '@seamnex/domain';
import { ProfileValueEditor, ProfileValueTable } from '../../src/features/admin/profile-values';
import type { Declarations } from '../../src/features/admin/profile-declarations';

/**
 * FR-1.26 / AC-51 — the value editor, driven directly.
 *
 * The page-level tests run against the mock backend, where every declared secret is also capped at
 * `none`; that combination never reaches the secret-reference branch. The editor is rendered here
 * with hand-built declarations so the branches that only fire for a *secret, overridable* variable —
 * and for a failed write, a pending write and an empty candidate list — are all exercised.
 */
const replace = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: null as unknown,
}));

// Partial: `QueryError` reaches into the same package for `toProblem`, and the editor renders it.
vi.mock('@seamnex/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useReplaceEnvProfileValues: () => replace };
});

beforeEach(() => {
  replace.mutate.mockReset();
  replace.isPending = false;
  replace.isError = false;
  replace.error = null;
});

function profile(overrides: Partial<EnvProfile> = {}): EnvProfile {
  return {
    key: 'production',
    name: 'Production',
    target: 'production',
    updatedBy: 'alice',
    updatedAt: '2026-02-01T00:00:00.000Z',
    values: [{ varName: 'SMTP_PORT', value: '587', secretRef: null }],
    ...overrides,
  } as EnvProfile;
}

function declarations(
  rows: [
    name: string,
    ceiling: 'none' | 'profile_only' | 'profile_and_instance',
    secret: boolean,
  ][],
): Declarations {
  return new Map(
    rows.map(([name, ceiling, secret]) => [name, [{ entryKey: 'D01-01', ceiling, secret }]]),
  );
}

describe('profile value editor', () => {
  it('offers a secret reference, never a value, for a secret variable', () => {
    render(
      <ProfileValueEditor
        profile={profile()}
        declarations={declarations([['API_KEY', 'profile_and_instance', true]])}
        editing={null}
        canManage
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Secret reference')).toBeDefined();
    expect(screen.queryByLabelText('Value')).toBeNull();

    fireEvent.change(screen.getByLabelText('Secret reference'), {
      target: { value: 'secret://platform/api-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }));

    // The value column is never filled for a secret: only the reference travels.
    expect(replace.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'production',
        values: [
          { varName: 'SMTP_PORT', value: '587', secretRef: null },
          { varName: 'API_KEY', value: null, secretRef: 'secret://platform/api-key' },
        ],
      }),
      expect.anything(),
    );
  });

  it('refuses to save when every declaration caps the variable at none', () => {
    render(
      <ProfileValueEditor
        profile={profile()}
        declarations={declarations([['WP_HOME', 'none', false]])}
        editing={null}
        canManage
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('This variable cannot be set from a profile')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save value' }).hasAttribute('disabled')).toBe(true);
  });

  it('replaces the edited row instead of appending a second one', () => {
    const onClose = vi.fn();
    render(
      <ProfileValueEditor
        profile={profile()}
        declarations={declarations([['SMTP_PORT', 'profile_only', false]])}
        editing={{ varName: 'SMTP_PORT', value: '587', secretRef: null }}
        canManage
        onClose={onClose}
      />,
    );

    expect(screen.getByText('Edit SMTP_PORT')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '2525' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }));

    expect(replace.mutate).toHaveBeenCalledWith(
      {
        key: 'production',
        values: [{ varName: 'SMTP_PORT', value: '2525', secretRef: null }],
      },
      expect.anything(),
    );
  });

  it('shows the server field error against the input that caused it', () => {
    replace.isError = true;
    replace.error = {
      fieldErrors: [{ field: 'SMTP_HOST', message: 'Must be an integer between 1 and 65535.' }],
    };

    render(
      <ProfileValueEditor
        profile={profile()}
        declarations={declarations([
          ['SMTP_HOST', 'profile_only', false],
          ['SMTP_PORT', 'profile_only', false],
        ])}
        editing={null}
        canManage
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Must be an integer between 1 and 65535.')).toBeDefined();
  });

  it('says so when no declared variable is left to set', () => {
    render(
      <ProfileValueEditor
        profile={profile()}
        declarations={declarations([['SMTP_PORT', 'profile_only', false]])}
        editing={null}
        canManage
        onClose={vi.fn()}
      />,
    );

    // SMTP_PORT is already set by the profile, so the only candidate is the row being replaced.
    expect(screen.getByText('No declared variable is available')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save value' }).hasAttribute('disabled')).toBe(true);
  });

  it('reports progress on the button while the write is in flight', () => {
    replace.isPending = true;

    render(
      <ProfileValueEditor
        profile={profile()}
        declarations={declarations([
          ['SMTP_PORT', 'profile_only', false],
          ['SMTP_HOST', 'profile_only', false],
        ])}
        editing={null}
        canManage
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Saving…' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('profile value table', () => {
  it('renders an empty value as a dash and a secret as a masked reference', () => {
    render(
      <ProfileValueTable
        profile={profile({
          values: [
            { varName: 'EMPTY_VAR', value: null, secretRef: null },
            { varName: 'API_KEY', value: null, secretRef: 'secret://platform/api-key' },
          ],
        })}
        declarations={declarations([
          ['EMPTY_VAR', 'profile_and_instance', false],
          ['API_KEY', 'profile_and_instance', true],
        ])}
        canManage
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText('—')).toBeDefined();
    expect(screen.getByText(/secret:\/\/platform\/api-key/)).toBeDefined();
    // The secret's value is never rendered, only its reference.
    expect(screen.queryByText('secret-value')).toBeNull();
  });

  it('explains an empty profile rather than showing an empty table', () => {
    render(
      <ProfileValueTable
        profile={profile({ values: [] })}
        declarations={new Map()}
        canManage
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText(/This profile sets no values/)).toBeDefined();
  });
});
