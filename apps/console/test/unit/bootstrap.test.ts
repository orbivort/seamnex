import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Boot work that must not block first paint: the mock platform starts once per document, the
 * session resolves before any screen mounts, and a failure before React owns the document still
 * lands a styled sentence in the markup `index.html` ships.
 */
vi.mock('@seamnex/mocks', () => ({
  resetState: vi.fn(),
}));

vi.mock('@seamnex/mocks/browser', () => ({
  startMockWorker: vi.fn(() => Promise.resolve()),
}));

const { resetState } = await import('@seamnex/mocks');
const { startMockWorker } = await import('@seamnex/mocks/browser');
const { mockPlatformReady, prepareMockPlatform, resolveSession, revealBootFailure } =
  await import('../../src/bootstrap');

afterEach(() => {
  vi.clearAllMocks();
});

describe('mock platform bootstrap', () => {
  it('installs the platform once even when an effect runs twice', async () => {
    await prepareMockPlatform('empty');
    await prepareMockPlatform('healthy');

    expect(resetState).toHaveBeenCalledTimes(1);
    expect(resetState).toHaveBeenCalledWith('empty');
    expect(startMockWorker).toHaveBeenCalledTimes(1);
  });

  it('reports readiness only after the platform has started', async () => {
    await prepareMockPlatform('degraded');
    await expect(mockPlatformReady()).resolves.toBeUndefined();
  });

  it('hands the session through unchanged while the mock platform is on', async () => {
    const session = { role: 'R1', scenario: 'degraded', latencyMs: 0 } as never;
    await expect(resolveSession(session)).resolves.toBe(session);
  });
});

describe('boot failure surface', () => {
  it('reveals the fallback the document ships and writes the problem detail into it', () => {
    document.body.innerHTML = `
      <div id="root"></div>
      <div id="boot-fallback" hidden>
        <p data-boot-detail></p>
      </div>
    `;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    revealBootFailure(new Error('the API did not answer'));

    const fallback = document.getElementById('boot-fallback')!;
    expect(document.getElementById('root')?.hasAttribute('hidden')).toBe(true);
    expect(fallback.hasAttribute('hidden')).toBe(false);
    expect(fallback.querySelector('[data-boot-detail]')?.textContent).toBe(
      'the API did not answer',
    );
    expect(error).toHaveBeenCalled();
  });

  it('does nothing when the document has no fallback to reveal', () => {
    document.body.innerHTML = '<div id="root"></div>';
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => revealBootFailure('not an error')).not.toThrow();
    expect(error).toHaveBeenCalled();
  });

  it('leaves a fallback without a detail node intact', () => {
    document.body.innerHTML = `
      <div id="root"></div>
      <div id="boot-fallback" hidden></div>
    `;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    revealBootFailure(new Error('cannot start'));

    expect(document.getElementById('boot-fallback')?.hasAttribute('hidden')).toBe(false);
  });
});
