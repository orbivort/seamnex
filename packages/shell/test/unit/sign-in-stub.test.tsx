import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@seamnex/api-client';
import type * as ApiClient from '@seamnex/api-client';
import type { AuthSession, PlatformRole, ProblemDetail } from '@seamnex/domain';
import { StubSignInForm, readInitialRole } from '../../src/sign-in-stub';
import { signedInSession } from '../fixtures';

/**
 * The development sign-in exists so the stub provider can be exercised without Keycloak, and the
 * only thing standing between it and a screenshot run is that its failure paths are as honest as
 * the live provider's: a second factor is a second step, a rate limit names the wait, and anything
 * unexpected still leaves a message rather than a dead form.
 */
const api = vi.hoisted(() => ({ signInWithStub: vi.fn() }));

vi.mock('@seamnex/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return { ...actual, ...api };
});

function problem(overrides: Partial<ProblemDetail> = {}): ProblemDetail {
  return {
    type: 'https://platform.seamnex.local/problems/rate-limited',
    title: 'Too many attempts',
    status: 429,
    detail: 'Wait before trying again.',
    code: 'RATE_LIMITED',
    fieldErrors: [],
    remediation: 'Wait, then retry.',
    ...overrides,
  };
}

function renderForm(
  onSession: (session: AuthSession) => void = vi.fn(),
  initialRole: PlatformRole = 'R5',
): void {
  render(<StubSignInForm initialRole={initialRole} onSession={onSession} />);
}

beforeEach(() => {
  api.signInWithStub.mockResolvedValue(signedInSession('R5'));
});

describe('StubSignInForm identity step', () => {
  it('offers every development identity and preselects the one it was given', () => {
    renderForm(vi.fn(), 'R1');

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(6);
    expect(screen.getByRole('radio', { name: /Platform administrator/ })).toHaveProperty(
      'checked',
      true,
    );
    expect(screen.getByRole('radio', { name: /Member/ })).toHaveProperty('checked', false);
  });

  it('moves the selection when another identity is chosen', () => {
    renderForm();

    const auditor = screen.getByRole('radio', { name: /Auditor/ });
    fireEvent.click(auditor);

    expect(auditor).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: /Member/ })).toHaveProperty('checked', false);
  });

  it('falls back to the default identity for a role it does not know', async () => {
    // A hand-edited `?role=` never reaches here — `readInitialRole` filters it — so this is the
    // defensive row of the table, exercised directly rather than pretended to be reachable. No
    // radio matches the unknown role, so the exchange has to fall back to the default identity.
    renderForm(vi.fn(), 'R9' as PlatformRole);

    expect(screen.getAllByRole('radio')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await vi.waitFor(() => expect(api.signInWithStub).toHaveBeenCalledWith('dev-user', undefined));
  });

  it('reports the wait the server asked for', async () => {
    api.signInWithStub.mockRejectedValue(new ApiError(problem(), { retryAfterMs: 4_400 }));

    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Too many attempts')).toBeDefined();
    expect(screen.getByText(/Wait before trying again\. Retry in 5 seconds\./)).toBeDefined();
  });

  it('omits the wait when the server did not name one', async () => {
    api.signInWithStub.mockRejectedValue(new ApiError(problem({ code: 'RATE_LIMITED' })));

    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Too many attempts')).toBeDefined();
    expect(screen.queryByText(/Retry in/)).toBeNull();
  });

  it('renders a refusal from any other problem code', async () => {
    api.signInWithStub.mockRejectedValue(
      new ApiError(problem({ code: 'FORBIDDEN', title: 'Refused', detail: 'No access.' })),
    );

    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Refused')).toBeDefined();
    expect(screen.getByText(/No access\./)).toBeDefined();
  });

  it('reports a failure that is not a platform problem at all', async () => {
    api.signInWithStub.mockRejectedValue(new Error('boom'));

    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Sign-in could not complete')).toBeDefined();
    expect(screen.getByText(/quote the request id/)).toBeDefined();
  });

  it('signs in and hands the session to the screen', async () => {
    const onSession = vi.fn();
    renderForm(onSession);

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await vi.waitFor(() => expect(onSession).toHaveBeenCalledTimes(1));
    expect(api.signInWithStub).toHaveBeenCalledWith('dev-user', undefined);
    expect(onSession.mock.calls[0]?.[0]).toEqual(signedInSession('R5'));
  });

  it('holds the form while the exchange is in flight', async () => {
    let release: (session: AuthSession) => void = () => undefined;
    api.signInWithStub.mockReturnValue(
      new Promise<AuthSession>((resolve) => {
        release = resolve;
      }),
    );

    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const pending = screen.getByRole('button', { name: 'Starting session…' });
    expect(pending).toHaveProperty('disabled', true);

    release(signedInSession('R5'));
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false),
    );
  });
});

describe('StubSignInForm second factor', () => {
  beforeEach(() => {
    api.signInWithStub.mockRejectedValueOnce(
      new ApiError(problem({ code: 'MFA_REQUIRED', title: 'A code is required', detail: 'Code.' })),
    );
  });

  it('asks for the code the identity requires, then sends it', async () => {
    const onSession = vi.fn();
    api.signInWithStub.mockResolvedValueOnce(signedInSession('R1'));
    renderForm(onSession, 'R1');

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Step 2 of 2')).toBeDefined();
    expect(screen.getByText('Platform administrator')).toBeDefined();

    const code = screen.getByPlaceholderText('000000');
    expect(screen.getByRole('button', { name: 'Verify and sign in' })).toHaveProperty(
      'disabled',
      true,
    );

    fireEvent.change(code, { target: { value: 'a1b2c3d4e5f6' } });
    expect((code as HTMLInputElement).value).toBe('123456');

    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));

    await vi.waitFor(() => expect(onSession).toHaveBeenCalledTimes(1));
    expect(api.signInWithStub).toHaveBeenLastCalledWith('dev-admin', '123456');
  });

  it('goes back to the identity list without keeping the code', async () => {
    renderForm(vi.fn(), 'R1');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Step 2 of 2');

    fireEvent.change(screen.getByPlaceholderText('000000'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.queryByText('Step 2 of 2')).toBeNull();
    expect(screen.getByRole('radio', { name: /Platform administrator/ })).toBeDefined();

    // The cleared code is what keeps the next attempt from re-sending the previous digits.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() =>
      expect(api.signInWithStub).toHaveBeenLastCalledWith('dev-admin', undefined),
    );
  });

  it('keeps the failure of a refused code on the second step', async () => {
    api.signInWithStub.mockRejectedValueOnce(
      new ApiError(problem({ code: 'MFA_INVALID', title: 'That code is wrong', detail: 'Retry.' })),
    );
    renderForm(vi.fn(), 'R1');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Step 2 of 2');

    fireEvent.change(screen.getByPlaceholderText('000000'), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));

    expect(await screen.findByText('That code is wrong')).toBeDefined();
    expect(screen.getByText('Step 2 of 2')).toBeDefined();
  });
});

describe('readInitialRole', () => {
  it('accepts a declared role', () => {
    expect(readInitialRole('R2')).toBe('R2');
  });

  it('falls back to the member role for anything else', () => {
    expect(readInitialRole(null)).toBe('R5');
    expect(readInitialRole('R9')).toBe('R5');
    expect(readInitialRole('')).toBe('R5');
  });
});
