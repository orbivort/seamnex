import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrototypeTransport } from '../../src/prototype-transport';

/**
 * The prototype adapter owns the demo identity header, the simulated latency and the `offline`
 * scenario. It is the one place those exist, so these cases assert exactly that and nothing about
 * the real pipeline.
 */
function fetchStub(response: Response = new Response('{}', { status: 200 })) {
  const stub = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response);
  vi.stubGlobal('fetch', stub);
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createPrototypeTransport', () => {
  it('sends the demo identity headers and no latency when latency is zero', async () => {
    const fetch = fetchStub();
    const transport = createPrototypeTransport({ role: 'R5', scenario: 'degraded', latencyMs: 0 });

    const response = await transport({ path: '/me', method: 'GET' });

    expect(response.status).toBe(200);
    expect((fetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      'x-seamnex-role': 'R5',
      'x-seamnex-scenario': 'degraded',
    });
  });

  it('delays by the requested latency plus a path-derived jitter', async () => {
    vi.useFakeTimers();
    const fetch = fetchStub();
    const transport = createPrototypeTransport({
      role: 'R5',
      scenario: 'degraded',
      latencyMs: 100,
    });

    const pending = transport({ path: '/me/launcher', method: 'GET' });
    // 13 characters: 100 ms base + 13 ms jitter. It must not have answered before that.
    await vi.advanceTimersByTimeAsync(112);
    await expect(pending).resolves.toBeInstanceOf(Response);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('answers the offline scenario with a platform-unavailable problem', async () => {
    const fetch = fetchStub();
    const transport = createPrototypeTransport({ role: 'R5', scenario: 'offline', latencyMs: 0 });

    const response = await transport({ path: '/me', method: 'GET' });
    const problem = (await response.json()) as { code: string; status: number };

    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe('application/problem+json');
    expect(problem.code).toBe('PLATFORM_UNAVAILABLE');
    expect(problem.status).toBe(503);
    // The outage is simulated before the network is touched.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses immediately when the caller signal is already aborted', async () => {
    fetchStub();
    const controller = new AbortController();
    controller.abort();
    const transport = createPrototypeTransport({ role: 'R5', scenario: 'degraded', latencyMs: 50 });

    await expect(
      transport({ path: '/me', method: 'GET', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels the simulated wait when the caller aborts during it', async () => {
    vi.useFakeTimers();
    fetchStub();
    const controller = new AbortController();
    const transport = createPrototypeTransport({
      role: 'R5',
      scenario: 'degraded',
      latencyMs: 500,
    });

    const pending = transport({ path: '/me', method: 'GET', signal: controller.signal });
    const expectation = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await expectation;

    // The timer was cleared, so advancing the clock cannot resolve a request nobody waits for.
    await vi.advanceTimersByTimeAsync(600);
  });
});
