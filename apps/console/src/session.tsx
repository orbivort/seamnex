import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { cn } from '@seamnex/utils';
import { PLATFORM_ROLES, ROLE_LABELS, SCENARIOS, SCENARIO_LABELS } from '@seamnex/domain';
import { devSignInAvailable } from '@seamnex/api-client';
import { createSessionKit, isPlatformRole, isScenario } from '@seamnex/shell';
import { applySessionTransport, assertedRole, mocksEnabled } from './api-mode';

/**
 * Session plumbing is shared with the portal (`@seamnex/shell`); only the defaults and the
 * switcher chrome differ. The transport is rebuilt before React re-renders, so the next
 * request already carries the new role.
 *
 * `assertedRole` is only defined in live mode: there the server's answer replaces the `?role=`
 * hint, which matters most in the console, whose prototype default is R1.
 */
const kit = createSessionKit({
  defaultRole: 'R1',
  defaultLatencyMs: 120,
  onChange: applySessionTransport,
  ...(assertedRole === undefined ? {} : { assertedRole }),
});

export const readSession = kit.readSession;
export const useSession = kit.useSession;

/**
 * The session reads its query parameters from the router, not from the platform location.
 *
 * The kit is router-agnostic, so this is the seam: the app owns the router and hands it the
 * search string. `App` mounts this provider *inside* `BrowserRouter` for that reason.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [params] = useSearchParams();
  return <kit.SessionProvider search={params.toString()}>{children}</kit.SessionProvider>;
}

/**
 * `w-full` because the controls are laid out by a grid in the footer, not by their own text width:
 * a `<select>` sized by its longest option made the three controls three different widths and
 * wrapped each one onto its own row.
 */
const SELECT_CLASS =
  'h-7 w-full min-w-0 cursor-pointer rounded-xs border border-line-strong bg-panel px-1.5 font-mono text-micro text-text hover:border-primary focus-visible:outline-offset-2';

export function ConsoleRoleSwitcher({ className }: { className?: string }) {
  const { session, setRole } = useSession();
  // Same rule as the portal: the switcher is a development affordance and disappears once a real
  // provider decides the role (ADR-BE-14). Against a live API with the stub provider it survives,
  // and is named for what it is there — a development override, not a prototype.
  if (!mocksEnabled && !devSignInAvailable()) return null;
  const label = mocksEnabled ? 'Prototype role' : 'Development role override';
  return (
    <label className={cn('flex items-center gap-1', className)}>
      <span className="sr-only">{label}</span>
      <select
        value={session.role}
        onChange={(event) => {
          if (isPlatformRole(event.target.value)) setRole(event.target.value);
        }}
        className={SELECT_CLASS}
        aria-label={`${label}: ${ROLE_LABELS[session.role].name}`}
      >
        {PLATFORM_ROLES.map((role) => (
          <option key={role} value={role}>
            {role} · {ROLE_LABELS[role].short}
          </option>
        ))}
      </select>
    </label>
  );
}

const LATENCY_STEPS = [0, 120, 400, 900, 2000] as const;

/**
 * The latency knob is part of the demo controls documented in the README; it only exists
 * while the mock platform is bundled, so a production build has no such control.
 */
export function ConsoleLatencySwitcher({ className }: { className?: string }) {
  const { session, setLatency } = useSession();
  if (!mocksEnabled) return null;
  return (
    <label className={cn('flex items-center gap-1', className)}>
      <span className="sr-only">Simulated latency</span>
      <select
        value={session.latencyMs}
        onChange={(event) => setLatency(Number(event.target.value))}
        className={SELECT_CLASS}
        aria-label={`Simulated network latency: ${session.latencyMs} milliseconds`}
      >
        {LATENCY_STEPS.map((value) => (
          <option key={value} value={value}>
            {value === 0 ? '0 ms' : `${value} ms`}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ConsoleScenarioSwitcher({ className }: { className?: string }) {
  const { session, setScenario } = useSession();
  // A live backend has no scenarios to switch; the control would only reload the page.
  if (!mocksEnabled) return null;
  return (
    <label className={cn('flex items-center gap-1', className)}>
      <span className="sr-only">Prototype scenario</span>
      <select
        value={session.scenario}
        onChange={(event) => {
          if (isScenario(event.target.value)) setScenario(event.target.value);
        }}
        className={SELECT_CLASS}
        title="Changing the scenario reloads a fresh mock platform state."
        aria-label={`Prototype scenario: ${SCENARIO_LABELS[session.scenario].label}`}
      >
        {SCENARIOS.map((scenario) => (
          <option key={scenario} value={scenario}>
            {SCENARIO_LABELS[scenario].label}
          </option>
        ))}
      </select>
    </label>
  );
}
