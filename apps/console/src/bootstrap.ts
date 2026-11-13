import { toProblem } from '@seamnex/api-client';
import type { SessionState } from '@seamnex/shell';
import { applyServerSession } from './api-mode';

/**
 * Boot work that must not block first paint.
 *
 * `main.tsx` renders synchronously and `SessionGate` awaits these steps, so the document shows
 * the splash (and then the product) while the mock platform installs and the server's session is
 * read. The ordering guarantee that mattered is preserved: no screen mounts — and therefore no
 * request is issued — before the platform it talks to is ready.
 */

let platform: Promise<void> | null = null;

/**
 * Starts the in-browser mock platform once per document.
 *
 * Module-level memoisation is deliberate: `StrictMode` mounts effects twice in development, and
 * a second `startMockWorker()` rejects because the worker is already active.
 */
export function prepareMockPlatform(scenario: SessionState['scenario']): Promise<void> {
  if (!__SEAMNEX_MOCKS__) return Promise.resolve();
  platform ??= (async () => {
    const { resetState } = await import('@seamnex/mocks');
    resetState(scenario);
    const { startMockWorker } = await import('@seamnex/mocks/browser');
    await startMockWorker();
  })();
  return platform;
}

/** Resolves once the mock platform is ready. A no-op when the entry never started one. */
export function mockPlatformReady(): Promise<void> {
  return platform ?? Promise.resolve();
}

/** Live mode: the role the server asserted must decide what renders, so it is read before mount. */
export function resolveSession(session: SessionState): Promise<SessionState> {
  return applyServerSession(session);
}

/**
 * Last-resort failure surface. The markup lives in `index.html`, so a failure that happens before
 * React owns the document still shows a styled sentence instead of a blank page — and the message
 * is written with `textContent`, never `innerHTML`.
 */
export function revealBootFailure(error: unknown): void {
  console.error('The console could not start', error);
  const fallback = document.getElementById('boot-fallback');
  if (fallback === null) return;
  document.getElementById('root')?.setAttribute('hidden', '');
  fallback.removeAttribute('hidden');
  const detail = fallback.querySelector('[data-boot-detail]');
  if (detail !== null) detail.textContent = toProblem(error).detail;
}
