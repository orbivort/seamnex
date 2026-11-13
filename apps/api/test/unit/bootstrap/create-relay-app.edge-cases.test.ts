import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@nestjs/common';
import type { AppConfig } from '../../../src/config/config';
import { createRelayApp } from '../../../src/bootstrap/create-relay-app';
import { LAUNCH_BOOTSTRAP_PATH } from '../../../src/common/launch/bootstrap';

/**
 * The launch hop reads `x-forwarded-host` first, because that is the name the browser used and the
 * one the relay has to present to the product. The fallbacks below are what a health check, a curl
 * from inside the network, or a proxy that strips the header actually looks like — and an empty host
 * must still reach the service, where it is refused, rather than throw out of the handler.
 *
 * Fastify is replaced by a single captured route so the handler can be called with headers light-my-
 * request cannot produce: a repeated `x-forwarded-host`, and a request with no `Host` at all.
 */
const h = vi.hoisted(() => {
  const routes = new Map<string, (request: unknown, reply: unknown) => Promise<unknown>>();
  const app = {
    get: (path: string, handler: (request: unknown, reply: unknown) => Promise<unknown>) => {
      routes.set(path, handler);
    },
    close: async () => undefined,
  };
  return { routes, app };
});

vi.mock('fastify', () => ({ default: () => h.app }));

const h2 = vi.hoisted(() => ({ redeem: vi.fn() }));
const config = {
  SESSION_COOKIE_NAME: 'seamnex_session',
  SESSION_COOKIE_SECURE: true,
  SEAMNEX_PRODUCT_URL_SCHEME: 'http',
  SEAMNEX_PRODUCT_URL_PORT: '8020',
} as unknown as AppConfig;

function logger(): Logger {
  return { warn: vi.fn(), log: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function reply() {
  const sent: { status: number; body: unknown } = { status: 0, body: undefined };
  const api = {
    code: (status: number) => {
      sent.status = status;
      return api;
    },
    send: (body?: unknown) => {
      sent.body = body;
      return api;
    },
    header: () => api,
    redirect: (_url: string, statusCode = 302) => {
      sent.status = statusCode;
      return api;
    },
    sent,
  };
  return api;
}

function handler() {
  const route = h.routes.get(LAUNCH_BOOTSTRAP_PATH);
  if (route === undefined) throw new Error('the launch hop was not registered');
  return route;
}

function build() {
  const log = logger();
  const relay = {
    attempt: vi.fn(
      async (): Promise<{
        kind: 'skipped' | 'failed' | 'relayed' | 'reused';
        reason?: string;
        cookies?: readonly string[];
      }> => ({ kind: 'skipped', reason: 'no_mapping' }),
    ),
  };
  createRelayApp(h2 as never, relay as never, config, log);
  return { log, relay };
}

describe('the launch hop host', () => {
  it('prefers the browser-facing host the proxy forwarded', async () => {
    const { log } = build();
    h2.redeem.mockResolvedValueOnce(null);

    const response = reply();
    await handler()(
      { headers: { 'x-forwarded-host': 'forwarded.localhost' }, query: { ticket: 't' } },
      response,
    );

    expect(response.sent.status).toBe(401);
    // A refused launch says the same thing to every caller; the log is the only place the host is
    // named, and the ticket is never among the fields.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'forwarded.localhost', status: 401 }),
      expect.any(String),
    );
  });

  it('falls back to the Host header when nothing was forwarded', async () => {
    build();
    h2.redeem.mockResolvedValueOnce(null);

    const response = reply();
    await handler()({ headers: { host: 'relay:8091' }, query: { ticket: 't' } }, response);

    expect(h2.redeem).toHaveBeenCalledWith(expect.objectContaining({ host: 'relay:8091' }));
  });

  it('takes the first value of a repeated forwarded header', async () => {
    build();
    h2.redeem.mockResolvedValueOnce(null);

    const response = reply();
    await handler()(
      {
        headers: { 'x-forwarded-host': ['first.localhost', 'second.localhost'] },
        query: { ticket: 't' },
      },
      response,
    );

    expect(h2.redeem).toHaveBeenCalledWith(expect.objectContaining({ host: 'first.localhost' }));
  });

  it('passes an empty host and no ticket through to the same refusal', async () => {
    const { log } = build();

    const response = reply();
    await handler()({ headers: {} }, response);

    expect(response.sent.status).toBe(401);
    // No ticket either: both facts are in the warning, neither is in the response.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ host: '', status: 401 }),
      expect.stringContaining('without a ticket'),
    );
    // A launch with no ticket is refused before the session store is touched.
    expect(h2.redeem).not.toHaveBeenCalledWith(expect.objectContaining({ host: '' }));
  });

  it('plants the relay cookies when the pass produced them', async () => {
    const { relay } = build();
    h2.redeem.mockResolvedValueOnce({ sessionId: 'sess-1', instanceId: 'i1', subjectIdpId: 's1' });
    relay.attempt.mockResolvedValueOnce({ kind: 'relayed', cookies: ['a=1; Path=/'] });

    const response = reply();
    await handler()(
      { headers: { host: 'openproject.localhost' }, query: { ticket: 'ticket-1' } },
      response,
    );

    expect(relay.attempt).toHaveBeenCalledWith(
      expect.objectContaining({ publicOrigin: 'http://openproject.localhost:8020' }),
    );
    expect(response.sent.status).toBe(302);
  });
});
