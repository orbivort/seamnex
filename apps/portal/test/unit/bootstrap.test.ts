import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `prepareMockPlatform` is what `main.tsx` runs before `createRoot`, so nothing in the render tree
 * reaches it. The worker start is replaced here: jsdom has no service-worker container, and the
 * behaviour worth asserting is the ordering (reset, then start) and the once-per-document memo.
 */
const { startMockWorker } = vi.hoisted(() => ({
  startMockWorker: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('@seamnex/mocks/browser', () => ({ startMockWorker }));

describe('bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    startMockWorker.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('installs the mock platform once and resolves the same promise afterwards', async () => {
    const { mockPlatformReady, prepareMockPlatform } = await import('../../src/bootstrap');

    // Nothing has been started yet, so the ready promise is already settled.
    await expect(mockPlatformReady()).resolves.toBeUndefined();

    const first = prepareMockPlatform('offline');
    const second = prepareMockPlatform('healthy');

    await expect(first).resolves.toBeUndefined();
    // The second call joins the same promise: the scenario of the first boot wins.
    expect(second).toBe(first);
    expect(startMockWorker).toHaveBeenCalledTimes(1);
    await expect(mockPlatformReady()).resolves.toBeUndefined();
  });

  it('delegates session resolution to the API-mode seam', async () => {
    const { resolveSession } = await import('../../src/bootstrap');
    const session = { role: 'R5', scenario: 'degraded', latencyMs: 0 } as const;

    // Mock mode answers with the session it was handed; live mode is unit-tested separately.
    await expect(resolveSession(session)).resolves.toEqual(session);
  });

  it('reveals the document-level failure surface with the problem detail', async () => {
    const { revealBootFailure } = await import('../../src/bootstrap');
    document.body.innerHTML = `
      <div id="root"></div>
      <div id="boot-fallback" hidden>
        <p data-boot-detail></p>
      </div>
    `;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    revealBootFailure(new Error('bundle could not be parsed'));

    const fallback = document.getElementById('boot-fallback');
    expect(fallback?.hasAttribute('hidden')).toBe(false);
    expect(document.getElementById('root')?.getAttribute('hidden')).toBe('');
    expect(fallback?.querySelector('[data-boot-detail]')?.textContent).toBe(
      'bundle could not be parsed',
    );
    expect(consoleError).toHaveBeenCalledWith('The portal could not start', expect.any(Error));
  });

  it('does nothing when the document has no fallback markup', async () => {
    const { revealBootFailure } = await import('../../src/bootstrap');
    document.body.innerHTML = '<div id="root"></div>';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => revealBootFailure('a string, not an Error')).not.toThrow();
    expect(document.getElementById('root')?.hasAttribute('hidden')).toBe(false);
  });
});
