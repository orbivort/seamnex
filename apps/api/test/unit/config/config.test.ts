import { describe, expect, it } from 'vitest';
import {
  aggregateConnections,
  ConfigError,
  describeConfig,
  loadConfig,
  poolMaxForRole,
  redactUrl,
} from '../../../src/config/config';

const BASE = {
  DATABASE_URL: 'postgres://seamnex:secret@localhost:5432/seamnex_platform',
  REDIS_URL: 'redis://localhost:6379',
} as const;

const PRODUCTION = {
  ...BASE,
  NODE_ENV: 'production',
  AUTH_PROVIDER: 'oidc',
  AUTH_ISSUER_URL: 'https://idp.example.test/realms/seamnex',
  SESSION_COOKIE_SECURE: '1',
  // The repository's published development credentials are refused in production, so a valid
  // production environment has to name its own storage keys.
  S3_ACCESS_KEY: 'prod_access_key',
  S3_SECRET_KEY: 'prod_secret_key',
} as const;

describe('configuration', () => {
  it('refuses to start without a database', () => {
    expect(() => loadConfig({ REDIS_URL: BASE.REDIS_URL })).toThrow(ConfigError);
  });

  it('refuses the stub identity provider in production, with no acknowledgement to opt out (ADR-BE-13)', () => {
    // The stub accepts a code the browser chose, so it authenticates nobody. Acknowledging that in
    // production was a switch that turned an auth bypass into a deployment choice.
    for (const extra of [{}, { AUTH_STUB_ACKNOWLEDGED: '1' }]) {
      expect(() =>
        loadConfig({
          ...BASE,
          NODE_ENV: 'production',
          SESSION_COOKIE_SECURE: '1',
          ...extra,
        }),
      ).toThrow(/AUTH_PROVIDER/);
    }
  });

  it('refuses the credentials published in this repository when NODE_ENV=production', () => {
    // A default that only exists for `pnpm dev` is not a secret: inheriting it in production would
    // encrypt every backup with a value printed in the README.
    const safe = { S3_ACCESS_KEY: 'prod_access_key', S3_SECRET_KEY: 'prod_secret_key' };
    expect(() => loadConfig({ ...PRODUCTION, ...safe, S3_ACCESS_KEY: 'seamnex_s3' })).toThrow(
      /S3_ACCESS_KEY/,
    );
    expect(() =>
      loadConfig({ ...PRODUCTION, ...safe, S3_SECRET_KEY: 'seamnex_s3_dev_password' }),
    ).toThrow(/S3_SECRET_KEY/);
  });

  it('refuses a non-secure session cookie in production', () => {
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: 'production',
        AUTH_PROVIDER: 'oidc',
      }),
    ).toThrow(/SESSION_COOKIE_SECURE/);
  });

  /*
   * ADR-BE-22 residual risk: with the relay on, Redis holds the product's own session cookies as
   * plain JSON — bearer credentials for a product the platform does not own. The ADR accepts that
   * only where Redis authenticates its clients and protects the transport, which used to be an
   * operator prerequisite nothing checked.
   */
  it('refuses an unprotected Redis in production when the relay caches product sessions there', () => {
    const relayed = { ...PRODUCTION, SEAMNEX_RELAY_ENABLED: '1' };

    expect(() => loadConfig(relayed)).toThrow(/REDIS_URL/);
    // Either half of the prerequisite is enough: TLS all the way, or an `AUTH` the URL carries.
    expect(loadConfig({ ...relayed, REDIS_URL: 'rediss://cache:6379' }).isProduction).toBe(true);
    expect(loadConfig({ ...relayed, REDIS_URL: 'redis://:s3cret@cache:6379' }).isProduction).toBe(
      true,
    );
    // The guard is about the relay's credential cache, not about Redis in general.
    expect(loadConfig(PRODUCTION).isProduction).toBe(true);
  });

  /*
   * The hop is written verbatim as a Traefik load-balancer server. A path or a missing scheme does
   * not degrade the launch — it makes the projection invalid, and one invalid server URL drops the
   * instance's whole router, so the product 404s with nothing in the platform log.
   */
  it('refuses a bootstrap hop that is not an http(s) origin', () => {
    for (const bad of [
      'relay:8091',
      'http://relay:8091/__seamnex/session',
      'http://relay:8091/?x=1',
      'ftp://relay:8091',
      'http://user:pass@relay:8091',
    ]) {
      expect(() => loadConfig({ ...BASE, SEAMNEX_BOOTSTRAP_URL: bad })).toThrow(
        /SEAMNEX_BOOTSTRAP_URL/,
      );
    }
    expect(
      loadConfig({ ...BASE, SEAMNEX_BOOTSTRAP_URL: 'http://relay:8091' }).SEAMNEX_BOOTSTRAP_URL,
    ).toBe('http://relay:8091');
  });

  it('defaults the role to api and parses booleans', () => {
    const config = loadConfig({ ...BASE });
    expect(config.SEAMNEX_ROLE).toBe('api');
    expect(config.AUTH_PROVIDER).toBe('stub');
    expect(config.isProduction).toBe(false);
    expect(config.SESSION_COOKIE_SECURE).toBe(false);
  });

  it('targets one composed catalogue key by default and parses a list for several products', () => {
    // The full key, because `catalog_entry.key` is a primary key: `D09-01` is OpenProject and no other
    // entry can hold it. The legacy `D9` is still accepted by the relay, but it is an alias.
    expect(loadConfig({ ...BASE }).SEAMNEX_RELAY_ENTRY_KEYS).toBe('D09-01');

    const both = loadConfig({ ...BASE, SEAMNEX_RELAY_ENTRY_KEYS: 'D09-01,D07-01' });
    expect(both.SEAMNEX_RELAY_ENTRY_KEYS.split(',')).toEqual(['D09-01', 'D07-01']);
  });

  it('accepts a production configuration with the live provider binding', () => {
    const config = loadConfig(PRODUCTION);
    expect(config.isProduction).toBe(true);
    expect(config.SESSION_COOKIE_SECURE).toBe(true);
    expect(config.allowedOrigins).toContain('http://localhost:5173');
    expect(config.authIssuer).toBe('https://idp.example.test/realms/seamnex');
    // One address, one realm: unset means the process reaches the provider at the public host.
    expect(config.authInternalBase).toBe(config.authIssuer);
  });

  it('requires an absolute issuer for the live provider', () => {
    // A missing issuer would validate nothing: `iss` is compared as an exact string, so a boot
    // without one fails every sign-in instead of failing at the moment it is still fixable.
    expect(() => loadConfig({ ...PRODUCTION, AUTH_ISSUER_URL: '' })).toThrow(/AUTH_ISSUER_URL/);
    expect(() =>
      loadConfig({ ...PRODUCTION, AUTH_ISSUER_URL: 'idp.example.test/realms/seamnex' }),
    ).toThrow(/absolute http/);
    expect(() =>
      loadConfig({ ...PRODUCTION, AUTH_INTERNAL_URL: 'keycloak:8080/realms/seamnex' }),
    ).toThrow(/absolute http/);
  });

  it('keeps the internal base distinct from the public issuer, and trims both', () => {
    const config = loadConfig({
      ...PRODUCTION,
      AUTH_ISSUER_URL: 'https://idp.example.test/realms/seamnex/',
      AUTH_INTERNAL_URL: ' http://keycloak:8080/realms/seamnex/ ',
    });
    expect(config.authIssuer).toBe('https://idp.example.test/realms/seamnex');
    expect(config.authInternalBase).toBe('http://keycloak:8080/realms/seamnex');
    expect(config.authScopes).toEqual(['openid', 'profile', 'email', 'groups']);
    expect(config.authRedirectPath).toBe('/sign-in');
  });

  it('does not demand an issuer from the development stub', () => {
    expect(loadConfig({ ...BASE, AUTH_PROVIDER: 'stub' }).authIssuer).toBe('');
  });

  it('trusts no proxy by default, so X-Forwarded-For cannot choose its own rate-limit bucket', () => {
    expect(loadConfig(BASE).trustProxy).toBe(false);
    expect(loadConfig({ ...BASE, TRUST_PROXY: '0' }).trustProxy).toBe(false);
    expect(loadConfig({ ...BASE, TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(loadConfig({ ...BASE, TRUST_PROXY: '10.0.0.0/8, 172.16.0.0/12' }).trustProxy).toEqual([
      '10.0.0.0/8',
      '172.16.0.0/12',
    ]);
  });

  it('registers exactly the callback paths a code may be exchanged for', () => {
    expect(loadConfig(BASE).authRedirectPaths).toEqual(['/sign-in']);
    expect(
      loadConfig({ ...BASE, AUTH_REDIRECT_PATHS: 'sign-in, /auth/callback/' }).authRedirectPaths,
    ).toEqual(['/sign-in', '/auth/callback/']);
  });

  it('normalises the origin allowlist', () => {
    const config = loadConfig({
      ...BASE,
      APP_ORIGINS: ' https://console.example.test/ , https://portal.example.test ',
    });
    expect(config.allowedOrigins).toEqual([
      'https://console.example.test',
      'https://portal.example.test',
    ]);
  });

  it('sizes the pool per role instead of applying the API ceiling to every worker', () => {
    // `DATABASE_POOL_MAX` used to be passed verbatim to all nine roles, so a default of ten became
    // ninety connections against a cluster sized for a hundred.
    expect(poolMaxForRole('api', 10)).toBe(10);
    expect(poolMaxForRole('deploy-worker', 10)).toBe(3);
    expect(poolMaxForRole('sync-worker', 10)).toBe(3);
    // A floor of two keeps a small pool usable rather than rounding a worker down to one.
    expect(poolMaxForRole('scheduler', 4)).toBe(2);
    expect(loadConfig({ ...BASE, SEAMNEX_ROLE: 'status-sampler' }).poolMax).toBe(3);
  });

  it('refuses a pool size that cannot fit inside the connection budget', () => {
    // Without this, `DATABASE_POOL_MAX=50` reads as "fifty per process" and fails at boot with
    // `too many clients already`, under whichever role happens to connect last.
    expect(aggregateConnections(50)).toBeGreaterThan(100);
    expect(() => loadConfig({ ...BASE, DATABASE_POOL_MAX: '50' })).toThrow(/DATABASE_POOL_MAX/);
    // The same size is allowed once the operator says the cluster can take it.
    expect(
      loadConfig({ ...BASE, DATABASE_POOL_MAX: '50', DATABASE_CONNECTION_BUDGET: '200' })
        .DATABASE_POOL_MAX,
    ).toBe(50);
  });

  it('redacts credentials from a connection string', () => {
    expect(redactUrl('postgres://seamnex:super-secret@db:5432/x')).not.toContain('super-secret');
  });

  it('redacts both halves of the userinfo, whichever one is present', () => {
    expect(redactUrl('postgres://user:pass@db:5432/x')).toBe(
      'postgres://********:********@db:5432/x',
    );
    expect(redactUrl('postgres://user@db:5432/x')).toBe('postgres://********@db:5432/x');
    // No userinfo at all: a password field that does not exist must not be invented.
    expect(redactUrl('postgres://db:5432/x')).toBe('postgres://db:5432/x');
  });

  it('redacts a password passed as a query parameter', () => {
    // `?sslpassword=` is where libpq accepts one, and it used to reach the boot log verbatim.
    const redacted = redactUrl('postgres://db:5432/x?sslpassword=hunter2&sslmode=require');

    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('sslmode=require');
    expect(redacted).toContain('sslpassword=********');
  });

  it('gives up on a value that is not a URL rather than echoing it', () => {
    expect(redactUrl('not a url at all')).toBe('********');
  });

  it('describes the running configuration without secrets', () => {
    const described = describeConfig(loadConfig({ ...BASE, AUTH_PROVIDER: 'stub' }));

    expect(described.authIssuer).toBe('(stub)');
    expect(described.database).not.toContain('secret');
    expect(described).toMatchObject({
      nodeEnv: 'development',
      authProvider: 'stub',
      poolMax: 10,
    });
  });

  it('names the issuer when there is one, so the boot line can be compared with the provider', () => {
    const described = describeConfig(loadConfig(PRODUCTION));

    expect(described.authIssuer).toBe('https://idp.example.test/realms/seamnex');
    expect(described.adaptersMode).toBeDefined();
  });

  it('reports every failing field of an invalid environment, not only the first', () => {
    try {
      loadConfig({});
      expect.unreachable('an empty environment must not load');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      expect(issues.length).toBeGreaterThan(1);
      expect(issues.every((issue) => issue.path.length > 0)).toBe(true);
    }
  });
});
