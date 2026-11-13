import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/config';
import { appConfigFactory, setLoadedConfig } from '../../../src/config/config.module';

const BASE = {
  DATABASE_URL: 'postgres://seamnex:secret@localhost:5432/seamnex_platform',
  REDIS_URL: 'redis://localhost:6379',
} as const;

/**
 * The regression these tests exist for: `runRole` parsed the environment with `SEAMNEX_ROLE` overridden
 * and then handed the *logger* that object, while every provider received a second parse of the
 * untouched `process.env` — where `SEAMNEX_ROLE` defaults to `api`. Eight of the nine roles reported the
 * wrong identity in metrics, in the Postgres `applicationName` and in audit attribution.
 */

function withEnv<T>(env: Readonly<Record<string, string>>, run: () => T): T {
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('config module', () => {
  afterEach(() => {
    setLoadedConfig(undefined);
  });

  it('serves the configuration the role lifecycle parsed, including its role', () => {
    const parsed = loadConfig({ ...BASE, SEAMNEX_ROLE: 'deploy-worker' });
    setLoadedConfig(parsed);

    // Identity, not equality: a second parse would still be *equal* to this object, and equality
    // is the weaker property. The process must hold exactly the object the lifecycle validated.
    expect(appConfigFactory()).toBe(parsed);
    expect(appConfigFactory().SEAMNEX_ROLE).toBe('deploy-worker');
  });

  it('replaces a previously published configuration', () => {
    setLoadedConfig(loadConfig({ ...BASE, SEAMNEX_ROLE: 'api' }));
    const sampler = loadConfig({ ...BASE, SEAMNEX_ROLE: 'status-sampler' });
    setLoadedConfig(sampler);

    expect(appConfigFactory().SEAMNEX_ROLE).toBe('status-sampler');
  });

  it('falls back to the environment when nothing was published (tests, scripts)', () => {
    setLoadedConfig(undefined);

    const config = withEnv(BASE, () => appConfigFactory());

    expect(config.SEAMNEX_ROLE).toBe('api');
    expect(config.isProduction).toBe(false);
  });
});
