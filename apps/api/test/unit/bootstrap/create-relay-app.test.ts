import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@nestjs/common';
import type { AppConfig } from '../../../src/config/config';
import type { ForwardAuthService } from '../../../src/modules/m11-forward-auth/forward-auth.contract';
import type { SignInRelay } from '../../../src/modules/m24-sign-in-relay/relay.contract';
import { LAUNCH_BOOTSTRAP_PATH } from '../../../src/common/launch/bootstrap';
import { createRelayApp } from '../../../src/bootstrap/create-relay-app';

/**
 * ADR-BE-22 — the launch hop with a relay in it.
 *
 * The tests pin the property the ADR turns on: a skipped relay and a failed relay both produce the
 * same response today's hop produces. The only difference a user may ever see is the product's own
 * page rendering signed in, or its login form.
 */
function makeConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    SESSION_COOKIE_NAME: 'seamnex_session',
    SESSION_COOKIE_SECURE: true,
    SEAMNEX_PRODUCT_URL_SCHEME: 'http',
    SEAMNEX_PRODUCT_URL_PORT: '8020',
    ...overrides,
  } as unknown as AppConfig;
}

function makeService(overrides: Record<string, unknown> = {}): ForwardAuthService {
  return {
    decide: vi.fn(async () => ({ allow: true, headers: {}, reason: 'test' })),
    redeem: vi.fn(async () => ({
      sessionId: 'sess-from-ticket',
      instanceId: 'instance-1',
      subjectIdpId: 'subject-1',
    })),
    ...overrides,
  } as unknown as ForwardAuthService;
}

function makeRelay(overrides: Record<string, unknown> = {}): SignInRelay {
  return {
    attempt: vi.fn(async () => ({ kind: 'skipped', reason: 'no_mapping' })),
    invalidate: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as SignInRelay;
}

const apps: { close: () => Promise<void> }[] = [];

/** The hop logs refusals; a test that does not assert them must not write to the console. */
function silentLogger(): Logger {
  return { warn: vi.fn(), log: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function build(
  service: ForwardAuthService,
  relay: SignInRelay,
  config = makeConfig(),
  logger: Logger = silentLogger(),
) {
  const app = createRelayApp(service, relay, config, logger);
  apps.push(app);
  return app;
}

function launch(app: ReturnType<typeof build>, ticket = 'ticket-1') {
  return app.inject({
    method: 'GET',
    url: `${LAUNCH_BOOTSTRAP_PATH}?ticket=${encodeURIComponent(ticket)}`,
    headers: { 'x-forwarded-host': 'openproject.localhost' },
  });
}

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const header = response.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header.map(String) : [String(header)];
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('relay launch bootstrap', () => {
  it('plants only the platform session when the relay has nothing to do', async () => {
    const app = build(makeService(), makeRelay());

    const response = await launch(app);

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/');
    const cookies = setCookies(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain('seamnex_session=sess-from-ticket');
  });

  it('plants the product cookie beside the platform session', async () => {
    const app = build(
      makeService(),
      makeRelay({
        attempt: vi.fn(async () => ({
          kind: 'relayed',
          cookies: ['_open_project_session=product-1; Path=/; HttpOnly; SameSite=Lax'],
        })),
      }),
    );

    const response = await launch(app);

    const cookies = setCookies(response);
    expect(cookies).toHaveLength(2);
    expect(cookies[1]).toContain('_open_project_session=product-1');
    expect(response.headers.location).toBe('/');
  });

  it('does not let a product cookie keep a Domain attribute from the product', async () => {
    const app = build(
      makeService(),
      makeRelay({
        attempt: vi.fn(async () => ({
          kind: 'reused',
          cookies: ['_open_project_session=product-1; Domain=openproject.example.com; Path=/'],
        })),
      }),
    );

    const cookies = setCookies(await launch(app));

    expect(cookies[1]?.toLowerCase()).not.toContain('domain=');
    expect(cookies[1]).toContain('Path=/');
  });

  it('gives a product cookie a root path when the product omitted one', async () => {
    const app = build(
      makeService(),
      makeRelay({
        attempt: vi.fn(async () => ({
          kind: 'relayed',
          cookies: ['_open_project_session=product-1'],
        })),
      }),
    );

    const cookies = setCookies(await launch(app));

    // Without this a browser scopes the cookie to `/__seamnex` and the product never sees it.
    expect(cookies[1]).toContain('Path=/');
  });

  it('refuses a product cookie that would shadow the platform session', async () => {
    const app = build(
      makeService(),
      makeRelay({
        attempt: vi.fn(async () => ({
          kind: 'relayed',
          // The product is on its own host and sees `seamnex_session` on every gated request; it may
          // not answer with a value of the same name and pin a session of its choosing.
          cookies: ['seamnex_session=planted-by-the-product', '_open_project_session=product-1'],
        })),
      }),
    );

    const cookies = setCookies(await launch(app));

    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain('seamnex_session=sess-from-ticket');
    expect(cookies.some((cookie) => cookie.includes('planted-by-the-product'))).toBe(false);
  });

  it('does not double the port the edge forwarded in the public origin', async () => {
    const attempt = vi.fn(async () => ({
      kind: 'skipped' as const,
      reason: 'no_mapping' as const,
    }));
    const app = build(makeService(), makeRelay({ attempt }));

    await app.inject({
      method: 'GET',
      url: `${LAUNCH_BOOTSTRAP_PATH}?ticket=ticket-1`,
      headers: { 'x-forwarded-host': 'openproject.localhost:8020' },
    });

    expect(attempt).toHaveBeenCalledWith(
      expect.objectContaining({ publicOrigin: 'http://openproject.localhost:8020' }),
    );
  });

  it('passes the route host and the public origin to the relay', async () => {
    const attempt = vi.fn(async () => ({
      kind: 'skipped' as const,
      reason: 'no_mapping' as const,
    }));
    const app = build(makeService(), makeRelay({ attempt }));

    await launch(app);

    expect(attempt).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      subjectIdpId: 'subject-1',
      routeHost: 'openproject.localhost',
      publicOrigin: 'http://openproject.localhost:8020',
    });
  });

  it('falls back to the platform session alone when the relay throws', async () => {
    const app = build(
      makeService(),
      makeRelay({
        attempt: vi.fn(async () => {
          throw new Error('relay exploded');
        }),
      }),
    );

    const response = await launch(app);

    expect(response.statusCode).toBe(302);
    expect(setCookies(response)).toHaveLength(1);
  });

  it('rejects a missing or unknown ticket without calling the relay', async () => {
    const attempt = vi.fn();
    const app = build(makeService(), makeRelay({ attempt }));

    const missing = await app.inject({
      method: 'GET',
      url: LAUNCH_BOOTSTRAP_PATH,
      headers: { 'x-forwarded-host': 'openproject.localhost' },
    });
    const unknown = await launch(
      build(makeService({ redeem: vi.fn(async () => null) }), makeRelay()),
    );

    expect(missing.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(attempt).not.toHaveBeenCalled();
  });

  /*
   * A refused launch answers the same `401` whatever the reason, so the response cannot say why.
   * Without a log line an expired, replayed or foreign-route ticket left no trace at all (NFR-4.8).
   * The ticket value is a single-use credential and never appears in the line.
   */
  it('logs a refused redemption with the host and status, never the ticket', async () => {
    const logger = silentLogger();
    const app = build(
      makeService({ redeem: vi.fn(async () => null) }),
      makeRelay(),
      makeConfig(),
      logger,
    );

    const response = await launch(app, 'ticket-that-must-not-be-logged');

    expect(response.statusCode).toBe(401);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'openproject.localhost', status: 401 }),
      expect.any(String),
    );
    expect(JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      'ticket-that-must-not-be-logged',
    );
  });

  it('answers a health probe without touching the relay', async () => {
    const app = build(makeService(), makeRelay());

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
  });
});
