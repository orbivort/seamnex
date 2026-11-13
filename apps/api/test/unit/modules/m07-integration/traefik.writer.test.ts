import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { LAUNCH_BOOTSTRAP_PATH } from '../../../../src/common/launch/bootstrap';
import {
  TraefikRouteWriter,
  type RouterSpec,
} from '../../../../src/modules/m07-integration/traefik.writer';

/**
 * The projection is the only thing between `instance_route` and a request reaching a product, and
 * its failures are silent: a Traefik file-provider document with one bad key loses the router, and
 * a gated route without the launch bootstrap leaves a signed-in user at a 401 they cannot clear.
 */

let dir: string;

function writer(): TraefikRouteWriter {
  const config = {
    SEAMNEX_TRAEFIK_DYNAMIC_DIR: dir,
    SEAMNEX_ADAPTERS_MODE: 'real',
  } as unknown as AppConfig;
  return new TraefikRouteWriter(config);
}

function spec(overrides: Partial<RouterSpec> = {}): RouterSpec {
  return {
    slug: 'shop',
    host: 'shop.localhost',
    pathPrefix: null,
    upstream: 'http://shop:80',
    published: true,
    forwardAuthAddress: 'http://auth-gateway:8090/verify',
    bootstrapAddress: 'http://auth-gateway:8090',
    authMode: 'fa_header',
    ...overrides,
  };
}

function projection(): {
  routers: Record<
    string,
    { rule: string; service: string; middlewares?: string[]; priority?: number }
  >;
  services: Record<string, { loadBalancer: { servers: { url: string }[] } }>;
  middlewares?: Record<string, { forwardAuth?: { address: string } }>;
} {
  const document = parse(readFileSync(join(dir, 'instance-shop.yml'), 'utf8')) as {
    http: ReturnType<typeof projection>;
  };
  return document.http;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seamnex-traefik-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('traefik route projection', () => {
  it('gates a forward-auth route and gives it a bootstrap router the middleware does not guard', () => {
    writer().write(spec());

    const { routers, services, middlewares } = projection();
    expect(routers['shop-product']?.middlewares).toEqual(['shop-auth', 'security-headers']);
    expect(middlewares?.['shop-auth']?.forwardAuth?.address).toBe(
      'http://auth-gateway:8090/verify',
    );

    const session = routers['shop-session'];
    expect(session?.rule).toBe(`Host(\`shop.localhost\`) && Path(\`${LAUNCH_BOOTSTRAP_PATH}\`)`);
    // No forward-auth here: this request exists to establish the cookie that middleware reads.
    expect(session?.middlewares).toEqual(['security-headers']);
    // It outranks the product router, so `/__seamnex/session` is not swallowed by the catch-all rule.
    expect(session?.priority ?? 0).toBeGreaterThan(routers['shop-product']?.priority ?? 0);
    expect(services['shop-session']?.loadBalancer.servers[0]?.url).toBe('http://auth-gateway:8090');
  });

  /**
   * A gate forwards the session cookie decision, not the identity. Forwarding `X-Platform-User`
   * and the group list to a product that only logs request headers is needless exposure — and it
   * is what let a proxy gate read as header-injection SSO (ADR-BE-15).
   */
  it('forwards identity headers only for the class that consumes them', () => {
    writer().write(spec({ authMode: 'fa_header' }));
    const forwarded = (
      projection() as unknown as {
        middlewares: Record<string, { forwardAuth?: { authResponseHeaders?: string[] } }>;
      }
    ).middlewares['shop-auth']?.forwardAuth?.authResponseHeaders;
    expect(forwarded).toEqual(['X-Platform-User', 'X-Platform-Groups', 'X-Platform-Instance']);

    for (const authMode of ['fa_gate', 'fa_delegated'] as const) {
      writer().write(spec({ authMode }));
      const gate = (
        projection() as unknown as {
          middlewares: Record<string, { forwardAuth?: { authResponseHeaders?: string[] } }>;
        }
      ).middlewares['shop-auth'];
      // Omitted, not an empty list: the middleware still gates the request.
      expect(gate?.forwardAuth?.authResponseHeaders).toBeUndefined();
    }
  });

  it('leaves a native product ungated and without a bootstrap route', () => {
    writer().write(spec({ authMode: 'native' }));

    const { routers, middlewares } = projection();
    expect(routers['shop-product']?.middlewares).toEqual(['security-headers']);
    expect(routers['shop-session']).toBeUndefined();
    expect(middlewares).toBeUndefined();
  });

  it('emits no router at all for an unpublished route', () => {
    writer().write(spec({ published: false }));
    expect(() => projection()).toThrow();
  });

  it('withdraws the file when a published route is unpublished', () => {
    const routes = writer();
    routes.write(spec());
    expect(() => projection()).not.toThrow();

    // Re-opening the gate is then a single projection rather than a remembered previous state.
    routes.write(spec({ published: false }));
    expect(() => projection()).toThrow();
  });

  it('adds a PathPrefix when the product publishes under a subpath', () => {
    writer().write(spec({ pathPrefix: '/app' }));

    expect(projection().routers['shop-product']?.rule).toBe(
      'Host(`shop.localhost`) && PathPrefix(`/app`)',
    );
  });

  it('treats a root path prefix as no prefix at all', () => {
    writer().write(spec({ pathPrefix: '/' }));

    expect(projection().routers['shop-product']?.rule).toBe('Host(`shop.localhost`)');
  });

  it('removes an already-absent file without failing', () => {
    expect(() => writer().remove('never-written')).not.toThrow();
  });

  it('refuses to project when the Traefik adapter is not configured', () => {
    const unconfigured = new TraefikRouteWriter({
      SEAMNEX_TRAEFIK_DYNAMIC_DIR: '',
      SEAMNEX_ADAPTERS_MODE: 'real',
    } as unknown as AppConfig);

    expect(() => unconfigured.write(spec())).toThrow(/SEAMNEX_TRAEFIK_DYNAMIC_DIR/);
  });
});
