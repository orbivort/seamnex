import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config';
import type { ForwardAuthService } from '../../../src/modules/m11-forward-auth/forward-auth.contract';
import { LAUNCH_BOOTSTRAP_PATH } from '../../../src/common/launch/bootstrap';
import { createForwardAuthApp } from '../../../src/bootstrap/create-forward-auth-app';

/**
 * The forward-auth listener answers Traefik, not a browser: `204` with identity headers or a bare
 * `401`. Anything else — a JSON problem document, a `403`, a redirect on the wrong path — is read
 * by the edge as a platform outage, so the exact status codes are the contract worth pinning.
 * `inject()` drives the real Fastify instance without binding a port.
 */
function makeConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    SESSION_COOKIE_NAME: 'seamnex_session',
    SESSION_COOKIE_SECURE: true,
    ...overrides,
  } as unknown as AppConfig;
}

function makeService(overrides: Record<string, unknown> = {}): ForwardAuthService {
  const service = {
    decide: vi.fn(async () => ({ allow: true, headers: {}, reason: 'test' })),
    redeem: vi.fn(async () => ({ sessionId: 'sess-from-ticket' })),
    ...overrides,
  };
  return service as unknown as ForwardAuthService;
}

const apps: { close: () => Promise<void> }[] = [];

function build(service: ForwardAuthService, config = makeConfig()) {
  const app = createForwardAuthApp(service, config);
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('forward-auth /verify', () => {
  it('answers 204 with the identity headers the edge forwards', async () => {
    const decide = vi.fn(async () => ({
      allow: true,
      headers: { 'x-seamnex-subject': 'user-1', 'x-seamnex-instance': 'shop' },
    }));
    const app = build(makeService({ decide }));

    const response = await app.inject({
      method: 'GET',
      url: '/verify',
      headers: {
        'x-forwarded-host': 'shop.localhost',
        'x-forwarded-uri': '/cart',
        cookie: 'seamnex_session=sess-abc; other=1',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['x-seamnex-subject']).toBe('user-1');
    expect(response.headers['x-seamnex-instance']).toBe('shop');
    expect(decide).toHaveBeenCalledWith({
      host: 'shop.localhost',
      path: '/cart',
      sessionId: 'sess-abc',
    });
  });

  it('falls back to Host and the request URL when the edge sends no forwarded headers', async () => {
    const decide = vi.fn(async () => ({ allow: true, headers: {} }));
    const app = build(makeService({ decide }));

    const response = await app.inject({
      method: 'GET',
      url: '/verify',
      headers: { host: 'shop.example.test' },
    });

    expect(response.statusCode).toBe(204);
    expect(decide).toHaveBeenCalledWith({
      host: 'shop.example.test',
      path: '/verify',
      sessionId: null,
    });
  });

  it('coerces repeated and absent headers to a single string', async () => {
    // A duplicated header reaches a Fastify handler as an array; an absent one as undefined. Both
    // must become a string before they are used as a host. `inject()` normalises both shapes away,
    // so the handlers are captured from a stand-in Fastify instead.
    const decide = vi.fn(async () => ({ allow: true, headers: {} }));
    const handlers = new Map<string, (request: unknown, reply: unknown) => Promise<unknown>>();
    const standIn = {
      get: (path: string, handler: never) => {
        handlers.set(path, handler);
      },
    };

    vi.resetModules();
    vi.doMock('fastify', () => ({ default: () => standIn }));
    const { createForwardAuthApp: create } =
      await import('../../../src/bootstrap/create-forward-auth-app');
    create(makeService({ decide }), makeConfig());
    vi.doUnmock('fastify');

    const reply = {
      code: () => reply,
      send: () => reply,
      header: () => reply,
      redirect: () => reply,
    };
    await handlers.get('/verify')?.(
      { headers: { 'x-forwarded-host': ['first.example', 'second.example'] }, url: '/verify' },
      reply,
    );
    expect(decide).toHaveBeenLastCalledWith({
      host: 'first.example',
      path: '/verify',
      sessionId: null,
    });

    await handlers.get('/verify')?.({ headers: {}, url: '/verify' }, reply);
    expect(decide).toHaveBeenLastCalledWith({ host: '', path: '/verify', sessionId: null });

    const redeem = vi.fn(async () => ({ sessionId: 'sess-1' }));
    create(makeService({ redeem }), makeConfig());
    await handlers.get(LAUNCH_BOOTSTRAP_PATH)?.({ headers: {}, query: { ticket: 't' } }, reply);
    expect(redeem).toHaveBeenCalledWith({ ticket: 't', host: '' });

    // A handler invoked without a parsed query is still a refusal, not a crash.
    redeem.mockClear();
    await handlers.get(LAUNCH_BOOTSTRAP_PATH)?.({ headers: {} }, reply);
    expect(redeem).not.toHaveBeenCalled();
  });

  it('denies with a bare 401 and no body', async () => {
    const decide = vi.fn(async () => ({ allow: false, reason: 'no session' }));
    const app = build(makeService({ decide }));

    const response = await app.inject({
      method: 'GET',
      url: '/verify',
      headers: { 'x-forwarded-host': 'shop.localhost' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toBe('');
    expect(response.headers['content-type']).toBeUndefined();
  });
});

describe('launch bootstrap', () => {
  it('redeems a ticket, sets a host-only session cookie and redirects to the product root', async () => {
    const redeem = vi.fn(async () => ({ sessionId: 'sess-9' }));
    const app = build(makeService({ redeem }), makeConfig({ SESSION_COOKIE_SECURE: false }));

    const response = await app.inject({
      method: 'GET',
      url: `${LAUNCH_BOOTSTRAP_PATH}?ticket=t-123`,
      headers: { 'x-forwarded-host': 'shop.localhost' },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/');
    expect(redeem).toHaveBeenCalledWith({ ticket: 't-123', host: 'shop.localhost' });

    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain('seamnex_session=sess-9');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // No `Domain`: the cookie belongs to the product host it was just set on.
    expect(cookie).not.toContain('Domain=');
  });

  it('marks the cookie Secure when the session cookie is configured that way', async () => {
    const app = build(makeService(), makeConfig({ SESSION_COOKIE_SECURE: true }));
    const response = await app.inject({
      method: 'GET',
      url: `${LAUNCH_BOOTSTRAP_PATH}?ticket=t-1`,
      headers: { host: 'shop.example.test' },
    });
    expect(String(response.headers['set-cookie'])).toContain('Secure');
  });

  it('refuses a request with no ticket without redeeming anything', async () => {
    const redeem = vi.fn(async () => ({ sessionId: 'never' }));
    const app = build(makeService({ redeem }));

    const response = await app.inject({
      method: 'GET',
      url: LAUNCH_BOOTSTRAP_PATH,
      headers: { host: 'shop.localhost' },
    });

    expect(response.statusCode).toBe(401);
    expect(redeem).not.toHaveBeenCalled();
  });

  it('ignores a ticket that is not a single string', async () => {
    const redeem = vi.fn(async () => ({ sessionId: 'never' }));
    const app = build(makeService({ redeem }));

    const response = await app.inject({
      method: 'GET',
      url: `${LAUNCH_BOOTSTRAP_PATH}?ticket=a&ticket=b`,
      headers: { host: 'shop.localhost' },
    });

    expect(response.statusCode).toBe(401);
    expect(redeem).not.toHaveBeenCalled();
  });

  it('refuses a ticket that no longer redeems', async () => {
    const redeem = vi.fn(async () => null);
    const app = build(makeService({ redeem: redeem as never }));

    const response = await app.inject({
      method: 'GET',
      url: `${LAUNCH_BOOTSTRAP_PATH}?ticket=expired`,
      headers: { host: 'shop.localhost' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});

describe('healthz', () => {
  it('answers 200 with a fixed body, without touching the service', async () => {
    const service = makeService();
    const app = build(service);

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(service.decide).not.toHaveBeenCalled();
    expect(service.redeem).not.toHaveBeenCalled();
  });
});
