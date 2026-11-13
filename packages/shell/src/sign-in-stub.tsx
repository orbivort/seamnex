import { useState, type FormEvent } from 'react';
import { ApiError, signInWithStub } from '@seamnex/api-client';
import { PLATFORM_ROLES, type AuthSession, type PlatformRole } from '@seamnex/domain';
import { Alert, Button, Field, Input } from '@seamnex/ui';

/**
 * The development sign-in, kept behind an explicit label.
 *
 * It exists because the live provider is not available in every environment (a laptop with no
 * Keycloak, a test harness, a screenshot run) and because the two providers must be exercised
 * against the same session surface. It is never the production path: the server refuses the stub
 * outside development (ADR-BE-13), and the screen says "Development identity" rather than
 * pretending otherwise.
 */

type Identity = {
  readonly role: PlatformRole;
  readonly username: string;
  readonly label: string;
  readonly detail: string;
  readonly secondFactor: boolean;
};

const IDENTITIES: readonly Identity[] = [
  {
    role: 'R1',
    username: 'dev-admin',
    label: 'Platform administrator',
    detail: 'Full control plane, second factor required',
    secondFactor: true,
  },
  {
    role: 'R2',
    username: 'dev-auditor',
    label: 'Auditor',
    detail: 'Read-only evidence, second factor required',
    secondFactor: true,
  },
  {
    role: 'R3',
    username: 'dev-owner',
    label: 'Domain owner',
    detail: 'Revenue & Customer domain',
    secondFactor: false,
  },
  {
    role: 'R4',
    username: 'dev-product',
    label: 'Product administrator',
    detail: 'Core CRM instance',
    secondFactor: false,
  },
  {
    role: 'R5',
    username: 'dev-user',
    label: 'Member',
    detail: 'Portal and entitled products',
    secondFactor: false,
  },
  {
    role: 'R6',
    username: 'dev-guest',
    label: 'Guest',
    detail: 'One product surface, invited access',
    secondFactor: false,
  },
];

const DEFAULT_IDENTITY = IDENTITIES[4] as Identity;

export function StubSignInForm({
  initialRole,
  onSession,
}: {
  initialRole: PlatformRole;
  onSession: (session: AuthSession) => void;
}) {
  const [role, setRole] = useState<PlatformRole>(initialRole);
  const [step, setStep] = useState<'identity' | 'second-factor'>('identity');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const identity = IDENTITIES.find((candidate) => candidate.role === role) ?? DEFAULT_IDENTITY;

  async function submit(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    setError(null);
    setPending(true);
    try {
      const session = await signInWithStub(
        identity.username,
        step === 'second-factor' ? code : undefined,
      );
      onSession(session);
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        setError({
          title: 'Sign-in could not complete',
          detail: 'Retry. If it persists, quote the request id.',
        });
        return;
      }
      if (caught.problem.code === 'MFA_REQUIRED') {
        setStep('second-factor');
        setError(null);
        return;
      }
      const retry =
        caught.problem.code === 'RATE_LIMITED' && caught.retryAfterMs !== null
          ? ` Retry in ${Math.ceil(caught.retryAfterMs / 1_000)} seconds.`
          : '';
      setError({ title: caught.problem.title, detail: `${caught.problem.detail}${retry}` });
    } finally {
      setPending(false);
    }
  }

  return (
    <div aria-live="polite">
      {error === null ? null : (
        <div className="mb-4">
          <Alert tone="danger" title={error.title}>
            {error.detail}
          </Alert>
        </div>
      )}

      {step === 'identity' ? (
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-muted label-caps-sans">Identity</legend>
            {IDENTITIES.map((candidate) => {
              const selected = candidate.role === role;
              return (
                <label
                  key={candidate.role}
                  className={[
                    'flex cursor-pointer items-start gap-3 rounded-sm border px-3 py-2.5 transition-colors duration-150',
                    selected
                      ? 'border-primary bg-primary-soft/70'
                      : 'border-line bg-panel hover:border-line-strong hover:bg-paper-deep',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="identity"
                    value={candidate.role}
                    checked={selected}
                    onChange={() => {
                      setRole(candidate.role);
                      setError(null);
                    }}
                    className="mt-1 size-3.5 accent-primary"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-body font-semibold text-text">{candidate.label}</span>
                      <span className="font-mono text-micro text-faint">{candidate.role}</span>
                    </span>
                    <span className="mt-0.5 block text-meta leading-snug text-muted">
                      {candidate.detail}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          <Button type="submit" variant="primary" size="lg" block disabled={pending}>
            {pending ? 'Starting session…' : 'Continue'}
          </Button>
        </form>
      ) : (
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <p className="label-caps flex items-center gap-2 text-muted">
            <span className="text-link">Step 2 of 2</span>
            <span className="text-faint">·</span>
            <span>{identity.label}</span>
          </p>
          <Field label="Six-digit code" hint="Development code: 123456" required>
            {/* eslint-disable jsx-a11y/no-autofocus -- step 2 replaces step 1's field, so moving the
                caret into the one-time-code box *is* the step change; nothing is stolen on load. */}
            <Input
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              className="text-center font-mono text-title tracking-[0.4em]"
              maxLength={6}
              required
            />
            {/* eslint-enable jsx-a11y/no-autofocus */}
          </Field>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setStep('identity');
                setCode('');
                setError(null);
              }}
              disabled={pending}
            >
              Back
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              disabled={pending || code.length !== 6}
            >
              {pending ? 'Verifying…' : 'Verify and sign in'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Only a same-origin path is a valid destination; `//evil.test` and absolute URLs are refused. */
export function readInitialRole(value: string | null): PlatformRole {
  return value !== null && (PLATFORM_ROLES as readonly string[]).includes(value)
    ? (value as PlatformRole)
    : 'R5';
}
