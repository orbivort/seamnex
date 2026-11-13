import { createFetchTransport, type Transport, type TransportRequest } from './transport';

/**
 * Prototype adapter: the only place where demo identity transport, simulated latency and
 * the `offline` scenario exist. Production builds never import this module.
 *
 * The `x-seamnex-role` / `x-seamnex-scenario` headers are demo metadata, not a control channel: no
 * server reads them, and the mock store ignores them (a scenario is applied when the store is
 * rebuilt). They exist so the demo traffic carries the identity it was rendered with; only the
 * `offline` branch below actually acts on the scenario.
 */

export type PrototypeTransportOptions = {
  role: string;
  scenario: string;
  /** Simulated round-trip in milliseconds; `0` keeps tests and demos instant. */
  latencyMs?: number;
};

const OFFLINE_PROBLEM = {
  type: 'https://platform.seamnex.local/problems/platform-unavailable',
  title: 'Platform API is unreachable',
  status: 503,
  detail:
    'The portal could not reach the control plane. Last known status is shown where available.',
  code: 'PLATFORM_UNAVAILABLE',
  fieldErrors: [],
  remediation:
    'Check the platform status page or retry in a moment. Existing product sessions are unaffected.',
};

function abortableDelay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Request aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Request aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createPrototypeTransport(options: PrototypeTransportOptions): Transport {
  const { role, scenario, latencyMs = 180 } = options;

  const base = createFetchTransport({
    headers: () => ({ 'x-seamnex-role': role, 'x-seamnex-scenario': scenario }),
  });

  return async (input: TransportRequest): Promise<Response> => {
    const jitter = latencyMs === 0 ? 0 : input.path.length % 90;
    await abortableDelay(latencyMs + jitter, input.signal);

    if (scenario === 'offline') {
      return new Response(JSON.stringify(OFFLINE_PROBLEM), {
        status: 503,
        headers: { 'Content-Type': 'application/problem+json' },
      });
    }

    return base(input);
  };
}
