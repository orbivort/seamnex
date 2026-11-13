import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIMEOUT_MS, createFetchTransport } from '../../src/transport';

/**
 * The fetch transport is the only place the browser's own semantics are assumed. These cases pin
 * the three things a screen depends on: the base URL, the headers (including the static/per-request
 * split), and the timeout that turns a hung request into a `TimeoutError` the pipeline can render.
 */
function fetchStub(): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', stub);
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createFetchTransport', () => {
  it('prefixes the default same-origin base and keeps credentials on', async () => {
    const fetch = fetchStub();

    await createFetchTransport()({ path: '/me', method: 'GET' });

    expect(fetch).toHaveBeenCalledWith('/api/v1/me', {
      method: 'GET',
      credentials: 'include',
      signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json' },
      body: null,
    });
  });

  it('serialises a body as JSON and adds the content type only then', async () => {
    const fetch = fetchStub();
    const transport = createFetchTransport({ baseUrl: 'https://api.seamnex.local' });

    await transport({ path: '/instances', method: 'POST', body: { slug: 'crm' } });

    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.seamnex.local/instances');
    expect(init.body).toBe('{"slug":"crm"}');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('merges static, resolved and per-request headers in that order', async () => {
    const fetch = fetchStub();
    const staticHeaders = createFetchTransport({
      headers: { 'x-static': 'a', 'x-shared': 'base' },
    });
    await staticHeaders({ path: '/x', method: 'GET', headers: { 'x-shared': 'request' } });

    expect((fetch.mock.calls[0]?.[1] as RequestInit).headers).toEqual({
      Accept: 'application/json',
      'x-static': 'a',
      'x-shared': 'request',
    });

    const resolvedHeaders = createFetchTransport({ headers: () => ({ 'x-seamnex-role': 'R5' }) });
    await resolvedHeaders({ path: '/x', method: 'GET' });
    expect((fetch.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      'x-seamnex-role': 'R5',
    });
  });

  it('aborts a hung request with a TimeoutError after the configured timeout', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const transport = createFetchTransport({ timeoutMs: 250 });

    const pending = transport({ path: '/slow', method: 'GET' });
    const expectation = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Request timed out after 250 ms',
    });
    await vi.advanceTimersByTimeAsync(250);
    await expectation;
  });

  it('uses the documented default timeout', async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
  });

  it('forwards a signal that is already aborted', async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init.signal?.aborted) reject(init.signal.reason);
          else init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort(new Error('navigated away'));

    await expect(
      createFetchTransport()({ path: '/me', method: 'GET', signal: controller.signal }),
    ).rejects.toThrow('navigated away');
  });

  it('forwards an abort that arrives while the request is in flight, and cleans the listener', async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');

    const pending = createFetchTransport()({
      path: '/me',
      method: 'GET',
      signal: controller.signal,
    });
    const expectation = expect(pending).rejects.toThrow('stop');
    controller.abort(new Error('stop'));
    await expectation;

    // The finally block removes the listener whatever the outcome.
    expect(remove).toHaveBeenCalled();
  });
});
