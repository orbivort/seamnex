import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * its failures are silent: a Traefik file-provider document with one bad key loses the router, a
 * gated route without the launch bootstrap leaves a signed-in user at a 401 they cannot clear, and a
 * router naming a certificate resolver or middleware the edge does not define is dropped with it
 * (ISSUE-07).
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
    tlsMode: 'acme',
    ...overrides,
  };
}

type Router = {
  rule: string;
  service: string;
  entryPoints: string[];
  middlewares?: string[];
  tls?: { certResolver?: string };
  priority?: number;
};

type Middleware = {
  forwardAuth?: { address: string; authResponseHeaders?: string[] };
  headers?: { stsSeconds?: number; stsIncludeSubdomains?: boolean };
};

function projection(): {
  routers: Record<string, Router>;
  services: Record<string, { loadBalancer: { servers: { url: string }[] } }>;
  middlewares: Record<string, Middleware>;
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
    expect(routers['shop-product']?.middlewares).toEqual(['shop-auth', 'shop-headers']);
    expect(middlewares['shop-auth']?.forwardAuth?.address).toBe('http://auth-gateway:8090/verify');

    const session = routers['shop-session'];
    expect(session?.rule).toBe(`Host(\`shop.localhost\`) && Path(\`${LAUNCH_BOOTSTRAP_PATH}\`)`);
    // No forward-auth here: this request exists to establish the cookie that middleware reads.
    expect(session?.middlewares).toEqual(['shop-headers']);
    // It outranks the product router, so `/__seamnex/session` is not swallowed by the catch-all rule.
    expect(session?.priority ?? 0).toBeGreaterThan(routers['shop-product']?.priority ?? 0);
    expect(services['shop-session']?.loadBalancer.servers[0]?.url).toBe('http://auth-gateway:8090');
  });

  /**
   * NFR-4.1: every external route is served over TLS. A router left on the plain entrypoint is a
   * plain-HTTP product that looks exactly like a working one until someone reads the config.
   */
  it('publishes on the HTTPS entrypoint and asks the edge resolver for a certificate', () => {
    writer().write(spec());

    const { routers } = projection();
    for (const router of Object.values(routers)) {
      expect(router.entryPoints).toEqual(['websecure']);
      expect(router.tls?.certResolver).toBe('seamnex');
    }
  });

  it('uses the edge’s own certificate when the route records the internal mode', () => {
    writer().write(spec({ tlsMode: 'internal' }));

    const { routers } = projection();
    // `{}` is "terminate here with the default certificate", not "no TLS".
    expect(routers['shop-product']?.tls).toEqual({});
    expect(routers['shop-session']?.tls).toEqual({});
  });

  /**
   * The headers used to be defined only in the development stack's static dynamic file. A deployment
   * that mounted its own directory lost the router, because the file provider rejects a document
   * whose middleware reference cannot be resolved.
   */
  it('carries its own security headers, including HSTS', () => {
    writer().write(spec());

    const headers = projection().middlewares['shop-headers']?.headers;
    expect(headers?.stsSeconds).toBe(31_536_000);
    expect(headers?.stsIncludeSubdomains).toBe(true);
  });

  /**
   * A gate forwards the session cookie decision, not the identity. Forwarding `X-Platform-User`
   * and the group list to a product that only logs request headers is needless exposure — and it
   * is what let a proxy gate read as header-injection SSO (ADR-BE-15).
   */
  it('forwards identity headers only for the class that consumes them', () => {
    writer().write(spec({ authMode: 'fa_header' }));
    expect(projection().middlewares['shop-auth']?.forwardAuth?.authResponseHeaders).toEqual([
      'X-Platform-User',
      'X-Platform-Groups',
      'X-Platform-Instance',
    ]);

    for (const authMode of ['fa_gate', 'fa_delegated'] as const) {
      writer().write(spec({ authMode }));
      const gate = projection().middlewares['shop-auth'];
      // Omitted, not an empty list: the middleware still gates the request.
      expect(gate?.forwardAuth?.authResponseHeaders).toBeUndefined();
    }
  });

  it('leaves a native product ungated and without a bootstrap route', () => {
    writer().write(spec({ authMode: 'native' }));

    const { routers, middlewares } = projection();
    expect(routers['shop-product']?.middlewares).toEqual(['shop-headers']);
    expect(routers['shop-session']).toBeUndefined();
    expect(middlewares['shop-auth']).toBeUndefined();
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

  /**
   * ISSUE-07: before ADR-BE-39 nothing ever deleted a document whose row was gone, so documents
   * written on the plain `web` entrypoint outlived their routes and kept being served.
   */
  it('deletes a generated document the database no longer accounts for', () => {
    const routes = writer();
    routes.write(spec());
    routes.write(spec({ slug: 'crm', host: 'crm.localhost' }));

    routes.prune(new Set(['shop']));

    expect(existsSync(join(dir, 'instance-shop.yml'))).toBe(true);
    expect(existsSync(join(dir, 'instance-crm.yml'))).toBe(false);
  });

  it('deletes every generated document when no route is left', () => {
    const routes = writer();
    routes.write(spec());

    routes.prune(new Set());

    expect(existsSync(join(dir, 'instance-shop.yml'))).toBe(false);
  });

  /** The same directory holds hand-written documents; they are not the projection's to remove. */
  it('leaves documents it did not write alone', () => {
    writeFileSync(join(dir, 'routes.yml'), 'http: {}\n', 'utf8');
    writeFileSync(join(dir, 'restore-gate.yml'), 'http: {}\n', 'utf8');

    writer().prune(new Set());

    expect(existsSync(join(dir, 'routes.yml'))).toBe(true);
    expect(existsSync(join(dir, 'restore-gate.yml'))).toBe(true);
  });

  it('tolerates a projection directory that does not exist', () => {
    const missing = new TraefikRouteWriter({
      SEAMNEX_TRAEFIK_DYNAMIC_DIR: join(dir, 'absent'),
      SEAMNEX_ADAPTERS_MODE: 'real',
    } as unknown as AppConfig);

    expect(() => missing.prune(new Set(['shop']))).not.toThrow();
  });
});
