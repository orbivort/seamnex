import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config';
import type { ForwardAuthService } from '../../../src/modules/m11-forward-auth/forward-auth.contract';
import { LAUNCH_BOOTSTRAP_PATH } from '../../../src/common/launch/bootstrap';
import { createForwardAuthApp } from '../../../src/bootstrap/create-forward-auth-app';

/**
 * Edge cases of the two routes the edge and the browser drive: the shapes a misconfigured proxy
 * sends (an empty forwarded header, a cookie that is not decodable) and the cookie contract the
 * launch bootstrap promises (name from config, no lifetime, host-only).
 *
 * The main suite pins the status codes; these pin the values inside them, because a wrong identity
 * header or a session cookie with a lifetime attached is a silent security or session-length change.
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

describe('forward-auth /verify: a header the edge should not send', () => {
  it('takes an empty x-forwarded-uri as the path instead of falling back to the request URL', async () => {
    // Traefik always sends the header, so an empty value is a proxy misconfiguration; replacing it
    // with `/verify` would let a policy rule written for one path apply to another.
    const decide = vi.fn(async () => ({ allow: true, headers: {} }));
    const app = build(makeService({ decide }));

    const response = await app.inject({
      method: 'GET',
      url: '/verify?next=%2Fcart',
      headers: { 'x-forwarded-host': 'shop.localhost', 'x-forwarded-uri': '' },
    });

    expect(response.statusCode).toBe(204);
    expect(decide).toHaveBeenCalledWith({ host: 'shop.localhost', path: '', sessionId: null });
  });

  it('reads only the cookie named by the session cookie name', async () => {
    // A sibling cookie that merely starts with the same characters is not the credential.
    const decide = vi.fn(async () => ({ allow: true, headers: {} }));
    const app = build(makeService({ decide }));

    await app.inject({
      method: 'GET',
      url: '/verify',
      headers: {
        'x-forwarded-host': 'shop.localhost',
        cookie: 'seamnex_session_extra=decoy; seamnex_session=sess-real',
      },
    });

    expect(decide).toHaveBeenCalledWith({
      host: 'shop.localhost',
      path: '/verify',
      sessionId: 'sess-real',
    });
  });

  it('treats a session cookie it cannot percent-decode as no session at all', async () => {
    const decide = vi.fn(async () => ({ allow: false, reason: 'no session' }));
    const app = build(makeService({ decide }));

    const response = await app.inject({
      method: 'GET',
      url: '/verify',
      headers: { 'x-forwarded-host': 'shop.localhost', cookie: 'seamnex_session=%E0%A4%A' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toBe('');
    expect(decide).toHaveBeenCalledWith({
      host: 'shop.localhost',
      path: '/verify',
      sessionId: null,
    });
  });
});

describe('launch bootstrap: the cookie the browser keeps', () => {
  it('names the cookie after the configured session cookie, not a literal', async () => {
    const redeem = vi.fn(async () => ({ sessionId: 'sess-9' }));
    const app = build(
      makeService({ redeem }),
      makeConfig({ SESSION_COOKIE_NAME: 'custom_sess', SESSION_COOKIE_SECURE: false }),
    );

    const response = await app.inject({
      method: 'GET',
      url: `${LAUNCH_BOOTSTRAP_PATH}?ticket=t-123`,
      headers: { 'x-forwarded-host': 'shop.localhost' },
    });

    expect(response.statusCode).toBe(302);
    expect(String(response.headers['set-cookie'])).toMatch(/^custom_sess=sess-9;/);
  });

  it('issues a browser-session cookie: no Max-Age, no Expires, no Domain', async () => {
    // The server-side session owns both deadlines; a cookie that outlives the tab would keep a
    // revoked session looking signed-in, and a Domain would leak it to sibling product hosts.
    const app = build(makeService());

    const response = await app.inject({
      method: 'GET',
      url: `${LAUNCH_BOOTSTRAP_PATH}?ticket=t-1`,
      headers: { host: 'shop.example.test' },
    });

    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain('Max-Age');
    expect(cookie).not.toContain('Expires');
    expect(cookie).not.toContain('Domain');
  });
});
