/**
 * Transport seam.
 *
 * Everything that touches the network lives behind `Transport`, so the mock adapter
 * (`createPrototypeTransport`) can be swapped for the real one without the HTTP pipeline,
 * the hooks or the screens changing. Nothing here knows about roles, scenarios or latency.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type TransportRequest = {
  path: string;
  method: HttpMethod;
  body?: unknown;
  signal?: AbortSignal | null;
  headers?: Record<string, string>;
};

export type Transport = (request: TransportRequest) => Promise<Response>;

export type FetchTransportOptions = {
  /** Server prefix. Production reads this from configuration, not from a literal. */
  baseUrl?: string;
  timeoutMs?: number;
  credentials?: RequestCredentials;
  /** Static headers or a resolver evaluated per request (auth token, tenant, …). */
  headers?: Record<string, string> | (() => Record<string, string>);
};

export const DEFAULT_TIMEOUT_MS = 15_000;

export function createFetchTransport(options: FetchTransportOptions = {}): Transport {
  const {
    baseUrl = '/api/v1',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    credentials = 'include',
    headers,
  } = options;

  return async ({ path, method, body, signal, headers: perRequest }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException(`Request timed out after ${timeoutMs} ms`, 'TimeoutError'));
    }, timeoutMs);

    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) forwardAbort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }

    const configured = typeof headers === 'function' ? headers() : (headers ?? {});

    try {
      return await fetch(`${baseUrl}${path}`, {
        method,
        credentials,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...configured,
          ...perRequest,
        },
        body: body === undefined ? null : JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forwardAbort);
    }
  };
}
