import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { PLATFORM_ROLES, ROLE_LABELS, SCENARIOS, SCENARIO_LABELS } from '@seamnex/domain';
import { devSignInAvailable } from '@seamnex/api-client';
import { createSessionKit, isPlatformRole, isScenario } from '@seamnex/shell';
import { applySessionTransport, assertedRole, mocksEnabled } from './api-mode';

/**
 * Session plumbing is shared with the console (`@seamnex/shell`); only the defaults and the
 * switcher chrome differ. The transport is rebuilt before React re-renders, so the next
 * request already carries the new role.
 *
 * `assertedRole` is only defined in live mode: there the server's answer replaces the `?role=`
 * hint, which the mock build still uses to switch identities.
 */
const kit = createSessionKit({
  defaultRole: 'R5',
  defaultLatencyMs: 180,
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

export function RoleSwitcher({ compact }: { compact?: boolean }) {
  const { session, setRole } = useSession();
  /*
   * Under a real identity provider this control cannot do what it says: `setRole` navigates to
   * `/sign-in?role=…`, which starts another provider login and asserts whatever that provider
   * decides. A control that only *looks* like a role switch is worse than none, so it exists only
   * where it works — the mock platform, or the development stub (ADR-BE-14).
   */
  if (!mocksEnabled && !devSignInAvailable()) return null;
  return (
    <label className={compact ? 'flex items-center gap-1.5' : 'flex flex-col gap-1'}>
      <span className="sr-only">Platform role</span>
      <select
        value={session.role}
        onChange={(event) => {
          if (isPlatformRole(event.target.value)) setRole(event.target.value);
        }}
        className="h-7 cursor-pointer rounded-xs border border-line-ink bg-ink-raised px-1.5 font-mono text-micro text-ink-text hover:border-primary-hover"
        aria-label={`Platform role: ${ROLE_LABELS[session.role].name}`}
      >
        {PLATFORM_ROLES.map((role) => (
          <option key={role} value={role} className="bg-ink text-ink-text">
            {role} · {ROLE_LABELS[role].short}
          </option>
        ))}
      </select>
    </label>
  );
}

const LATENCY_STEPS = [0, 180, 500, 1000, 2000] as const;

/** Demo control only: absent from a production build, where the mock platform is not bundled. */
export function LatencySwitcher() {
  const { session, setLatency } = useSession();
  if (!mocksEnabled) return null;
  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">Simulated latency</span>
      <select
        value={session.latencyMs}
        onChange={(event) => setLatency(Number(event.target.value))}
        className="h-7 cursor-pointer rounded-xs border border-line-ink bg-ink-raised px-1.5 font-mono text-micro text-ink-text hover:border-primary-hover"
        aria-label={`Simulated network latency: ${session.latencyMs} milliseconds`}
      >
        {LATENCY_STEPS.map((value) => (
          <option key={value} value={value} className="bg-ink text-ink-text">
            {value} ms
          </option>
        ))}
      </select>
    </label>
  );
}

export function ScenarioSwitcher() {
  const { session, setScenario } = useSession();
  // A live backend has no scenarios to switch; the control would only reload the page.
  if (!mocksEnabled) return null;
  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">Scenario</span>
      <select
        value={session.scenario}
        onChange={(event) => {
          if (isScenario(event.target.value)) setScenario(event.target.value);
        }}
        className="h-7 cursor-pointer rounded-xs border border-line-ink bg-ink-raised px-1.5 font-mono text-micro text-ink-text hover:border-primary-hover"
        aria-label={`Scenario: ${SCENARIO_LABELS[session.scenario].label}. Changing it reloads the mock platform.`}
        title="Changing the scenario reloads a fresh mock platform state."
      >
        {SCENARIOS.map((scenario) => (
          <option key={scenario} value={scenario} className="bg-ink text-ink-text">
            scenario: {SCENARIO_LABELS[scenario].label}
          </option>
        ))}
      </select>
    </label>
  );
}
