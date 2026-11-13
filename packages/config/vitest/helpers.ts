/**
 * The `openAs` helper every frontend test starts with, in the form of a factory.
 *
 * The *behaviour* is one line of plumbing — rewrite the URL, then repoint the request pipeline —
 * and it is identical in both apps. The *imports* are not: `readSession` and
 * `applySessionTransport` live in each app's `session`/`api-mode` modules, which read the app's
 * build-time flags and default role. Injecting them keeps this package free of app code, so a
 * change here cannot pull a Vite config (or an app) into a shared harness.
 */

/** The two app-specific seams `openAs` needs. Both are called once per invocation. */
export interface OpenAsDeps<TSession> {
  /** Reads the URL-derived session. Called after the URL is rewritten, never before. */
  readSession: () => TSession;
  /** Points the shared request pipeline at the transport that session selects. */
  applySessionTransport: (session: TSession) => void;
  /**
   * The scenario used when a call omits one. Injected by the app from `@seamnex/mocks` so the harness
   * and `openAs` cannot disagree about where a suite starts; a literal here would be a third copy
   * of that default.
   */
  defaultScenario: string;
}

/** `openAs(role)` opens `/` under the default scenario with no simulated latency. */
export type OpenAs = (role: string, path?: string, scenario?: string) => void;

export function createOpenAs<TSession>({
  readSession,
  applySessionTransport,
  defaultScenario,
}: OpenAsDeps<TSession>): OpenAs {
  return (role, path = '/', scenario = defaultScenario) => {
    // `latency=0` is deliberate even though the mock platform supports the demo latency knob:
    // the suite asserts content, and a simulated delay only makes assertions flaky.
    window.history.replaceState({}, '', `${path}?role=${role}&scenario=${scenario}&latency=0`);
    // Read *after* the rewrite so the pipeline is pointed at the session the URL now describes;
    // the reverse order would configure the transport for the previous role.
    applySessionTransport(readSession());
  };
}
